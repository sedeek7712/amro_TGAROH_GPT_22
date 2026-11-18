/**
 * نظام الإدارة التجارية والمحاسبية المتكامل
 * مراقب حالة الاتصال بالشبكة (Network Monitor Service & React Hook)
 * يكتشف التغيرات الفورية بين الاتصال والانقطاع ويطلق محفزات إعادة المحاولة التلقائية
 */

import { useState, useEffect } from 'react';

type NetworkCallback = (isOnline: boolean) => void;

class NetworkMonitor {
  private onlineStatus: boolean = typeof navigator !== 'undefined' ? navigator.onLine : true;
  private listeners: Set<NetworkCallback> = new Set();
  private initialized = false;

  constructor() {
    this.init();
  }

  private init() {
    if (this.initialized || typeof window === 'undefined') return;

    window.addEventListener('online', () => this.handleStatusChange(true));
    window.addEventListener('offline', () => this.handleStatusChange(false));
    this.initialized = true;
  }

  private handleStatusChange(isOnline: boolean) {
    this.onlineStatus = isOnline;
    console.log(`[NetworkMonitor] Connection changed: ${isOnline ? 'ONLINE' : 'OFFLINE'}`);
    this.listeners.forEach((callback) => {
      try {
        callback(isOnline);
      } catch (err) {
        console.error('[NetworkMonitor] Error in listener callback:', err);
      }
    });
  }

  public isOnline(): boolean {
    if (typeof navigator !== 'undefined') {
      return navigator.onLine;
    }
    return this.onlineStatus;
  }

  public subscribe(callback: NetworkCallback): () => void {
    this.listeners.add(callback);
    // استدعاء فوري بالحالة الحالية
    callback(this.isOnline());
    return () => {
      this.listeners.delete(callback);
    };
  }
}

export const networkMonitor = new NetworkMonitor();

/**
 * خطاف React لمراقبة حالة الاتصال بالشبكة لحظياً
 */
export function useNetworkStatus(): { isOnline: boolean } {
  const [isOnline, setIsOnline] = useState<boolean>(networkMonitor.isOnline());

  useEffect(() => {
    const unsubscribe = networkMonitor.subscribe((online) => {
      setIsOnline(online);
    });
    return unsubscribe;
  }, []);

  return { isOnline };
}
