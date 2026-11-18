$WshShell = New-Object -comObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("$env:USERPROFILE\Desktop\نظام الإدارة التجارية.lnk")
$Shortcut.TargetPath = "C:\Users\AL BASHA\Desktop\مشاريع htmlوcss\video\الجديد\تشغيل_النظام.bat"
$Shortcut.WorkingDirectory = "C:\Users\AL BASHA\Desktop\مشاريع htmlوcss\video\الجديد"
$Shortcut.Description = "نظام الإدارة التجارية والمحاسبية المتكامل"
$Shortcut.WindowStyle = 1
$Shortcut.Save()
Write-Host "تم انشاء الايقونة بنجاح!"
