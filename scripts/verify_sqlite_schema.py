#!/usr/bin/env python3
"""Smoke-test SQLite schema, persistence, transaction rollback and online backup."""
from __future__ import annotations
import hashlib
import json
import sqlite3
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "electron" / "sqlite" / "migrations" / "001_initial.sql"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    sql = SCHEMA.read_text(encoding="utf-8")
    digest = hashlib.sha256(sql.encode("utf-8")).hexdigest()
    with tempfile.TemporaryDirectory(prefix="erp-sqlite-check-") as folder:
        db_path = Path(folder) / "erp.sqlite"
        backup_path = Path(folder) / "erp-backup.sqlite"
        conn = sqlite3.connect(db_path, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=FULL")
        conn.executescript(sql)
        conn.execute(
            """INSERT OR IGNORE INTO schema_migrations
               (version,name,checksum_sha256,applied_at)
               VALUES (1,'001_initial',?,datetime('now'))""", (digest,)
        )
        expected = {
            "tenants", "branches", "activities", "accounts", "products",
            "product_batches", "parties", "invoices", "invoice_items",
            "invoice_stock_deductions", "journal_entries", "journal_entry_lines",
            "cash_boxes", "vouchers", "amanat_records", "users", "audit_logs",
            "outbox_queue", "sync_conflicts", "document_sequences", "pos_terminals",
            "device_registrations", "app_settings",
        }
        actual = {row["name"] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        require(expected.issubset(actual), "Missing one or more ERP schema tables")
        require(conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1,
                "Foreign-key checks are disabled")
        require(conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok",
                "SQLite integrity check failed")

        conn.execute(
            "INSERT INTO activities(tenant_id,id,code,data_json) VALUES(?,?,?,?)",
            ("tenant_main", "pharmacy", "PH", json.dumps({"id": "pharmacy"}))
        )
        conn.execute(
            """INSERT INTO products
               (tenant_id,id,activity_id,code,category,current_stock_decimal,data_json)
               VALUES(?,?,?,?,?,?,?)""",
            ("tenant_main", "product-1", "pharmacy", "P-001", "general", "10",
             json.dumps({"id": "product-1", "currentStock": 10}))
        )
        conn.execute(
            """INSERT INTO invoices
               (tenant_id,id,branch_id,invoice_number,invoice_type,activity_id,
                invoice_date,payment_method,total_decimal,paid_amount_decimal,data_json)
               VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            ("tenant_main", "invoice-1", "branch_main", "INV-001", "SALE", "pharmacy",
             "2026-11-20", "CASH", "125.50", "125.50",
             json.dumps({"id": "invoice-1", "total": 125.5}))
        )
        conn.execute(
            """INSERT INTO invoice_items
               (tenant_id,invoice_id,id,product_id,quantity_decimal,
                unit_price_decimal,total_decimal,data_json)
               VALUES(?,?,?,?,?,?,?,?)""",
            ("tenant_main", "invoice-1", "line-1", "product-1", "1", "125.50",
             "125.50", json.dumps({"id": "line-1", "productId": "product-1"}))
        )
        conn.execute(
            """INSERT INTO journal_entries
               (tenant_id,id,entry_number,entry_date,cost_center_id,status,data_json)
               VALUES(?,?,?,?,?,?,?)""",
            ("tenant_main", "entry-1", "JE-001", "2026-11-20", "pharmacy", "POSTED",
             json.dumps({"id": "entry-1", "status": "POSTED"}))
        )
        conn.execute(
            """INSERT INTO journal_entry_lines
               (tenant_id,entry_id,id,account_code,debit_decimal,credit_decimal,data_json)
               VALUES(?,?,?,?,?,?,?)""",
            ("tenant_main", "entry-1", "entry-line-1", "1001", "125.50", "0",
             json.dumps({"id": "entry-line-1", "debit": 125.5}))
        )

        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """INSERT INTO invoices
               (tenant_id,id,branch_id,invoice_number,invoice_type,activity_id,
                invoice_date,payment_method,total_decimal,paid_amount_decimal,data_json)
               VALUES('tenant_main','rollback-id','branch_main','ROLLBACK','SALE',
                      'pharmacy','2026-11-20','CASH','1','1','{}')"""
        )
        conn.execute(
            """INSERT INTO invoice_items
               (tenant_id,invoice_id,id,product_id,quantity_decimal,
                unit_price_decimal,total_decimal,data_json)
               VALUES('tenant_main','rollback-id','rollback-line','product-1','1','1','1','{}')"""
        )
        conn.execute("ROLLBACK")
        require(conn.execute(
            "SELECT COUNT(*) FROM invoices WHERE id='rollback-id'"
        ).fetchone()[0] == 0, "Rollback retained a partial invoice")

        backup = sqlite3.connect(backup_path)
        conn.backup(backup)
        backup.close()
        conn.close()

        reopened = sqlite3.connect(db_path)
        require(reopened.execute(
            "SELECT COUNT(*) FROM invoices WHERE id='invoice-1'"
        ).fetchone()[0] == 1, "Committed invoice was lost after closing and reopening")
        reopened.close()

        backup_check = sqlite3.connect(backup_path)
        require(backup_check.execute(
            "SELECT COUNT(*) FROM invoice_items WHERE invoice_id='invoice-1'"
        ).fetchone()[0] == 1, "Online backup omitted invoice items")
        require(backup_check.execute("PRAGMA integrity_check").fetchone()[0] == "ok",
                "Backup integrity check failed")
        backup_check.close()
    print("PASS: schema, foreign keys, rollback, reopen persistence and online backup")


if __name__ == "__main__":
    main()
