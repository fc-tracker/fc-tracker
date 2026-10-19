; Installer hooks (tauri.conf.json > bundle > windows > nsis > installerHooks).

; Updates replace fc-tracker.exe in place; Explorer caches icons per path and would keep
; showing the previous icon (taskbar, Start menu). Tell it that icons changed.
!macro NSIS_HOOK_POSTINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

; fctracker:// is registered by the app itself (HKCU); remove it with the app.
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\fctracker"
  ; the "Start with Windows" entry and the installer's memory of the choice
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FC-Tracker"
  DeleteRegKey HKCU "Software\FC-Tracker"
!macroend
