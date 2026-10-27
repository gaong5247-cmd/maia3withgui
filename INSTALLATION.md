# Maia Studio installation, updates, and safe cleanup

## Windows setup (v0.2.0+)

1. Download the latest `Maia.Studio_*_x64-setup.exe` (per-user install; **no Administrator elevation is normally required**), or the standalone `maia-studio_windows_x64.exe`.
2. Install and start Maia Studio.
3. Open **Engine Controls → Python & checkpoint configuration** and click **Install Maia3-79M environment**.
4. If Python is not available on PATH, specify a trusted Python 3.10+ `python.exe` first.
5. The app creates the environment and validates `torch`, `python-chess` and `maia3.uci`. If you use a custom 79M checkpoint path, the checkpoint download is skipped. Otherwise it downloads the official checkpoint once and reuses the cache.
6. Set Elo/Temperature/MultiPV and start analysis.

## Where the files live

| Content | v0.1.0 (legacy) | v0.2.0+ |
| --- | --- | --- |
| Python packages | `%APPDATA%\\com.gaong.maia.studio\\maia-python` | `%LOCALAPPDATA%\\MaiaStudioRuntime\\maia3-79m-v1` |
| Model cache | default Hugging Face cache | `%LOCALAPPDATA%\\MaiaStudioRuntime\\huggingface` |
| Session backup | `%APPDATA%\\com.gaong.maia.studio\\session.json` | `%LOCALAPPDATA%\\MaiaStudioRuntime\\session.json` |
| Installed EXE | Tauri installer-managed | Tauri installer-managed |

The model and runtime are **not bundled in the Windows installer**. They are installed once using a user-supplied Python interpreter and then stored separately from the app itself.

## Why uninstalling v0.1.0 could fail

The old environment was mistakenly installed below the bundle's Roaming app data directory. The default Tauri NSIS uninstaller's optional **Delete the application data** action recursively deletes both the Roaming and Local app-data directories bearing the bundle identifier. For a large Python environment that can take a long time; locked or permission-denied files may block deletion. The v0.2.0 design avoids that location entirely.

**A new installer cannot change the uninstall script that was previously installed by v0.1.0.** If that old uninstaller blocks an update, run the standalone v0.2.0 EXE first. You can switch to the new installer after resolving old uninstall issues.

## Safely cleaning only the old v0.1.0 Python folder

1. Close Maia Studio and any Python process that specifically executes from the legacy Maia path. Do **not** terminate unrelated Python programs.
2. Open the new standalone EXE and complete the new backend installation.
3. In **Engine Controls**, use the **Clean old v0.1.0 Python files** button. It verifies the exact legacy directory and requires confirmation. It does **not** elevate privileges and will report a clear error if Windows has locked a file.
4. If you prefer manual cleanup, open regular PowerShell **as the same Windows user that installed the v0.1.0 runtime**:

```powershell
$legacy = Join-Path $env:APPDATA 'com.gaong.maia.studio\maia-python'
if (Test-Path -LiteralPath $legacy) {
    Write-Host "Old Maia v0.1.0 environment:" $legacy
    Remove-Item -LiteralPath $legacy -Recurse -Force -ErrorAction Stop
}
```

If permission is denied, check the exact file and owner and reboot before trying again. **Do not run recursive ACL or ownership changes against the whole AppData directory.** Avoid using Administrator unless the account or file ACL genuinely requires it. Contact us via GitHub Issues with the exact error message if cleanup still fails.

**Never delete** `%LOCALAPPDATA%\\MaiaStudioRuntime` while the new backend is running. It holds the new environment, checkpoint cache and session history.

## Uninstall / reinstall semantics

- Uninstalling the GUI removes the app installation. Tauri NSIS may offer **Delete the application data** for its bundle identifier; this removes WebView storage and app-identifier directories, but **not** the independently named `MaiaStudioRuntime`.
- The app deliberately never automatically deletes the new Python environment and model cache on uninstall, to support clean upgrades and reduce gigabytes of redundant downloads.
- Full data removal is a **separate, explicitly chosen task**. Export important PGNs and close the app. If you want to fully reset Maia Studio (including the session), remove `%LOCALAPPDATA%\\MaiaStudioRuntime` manually after uninstalling. Do not delete a path without first checking its full resolved location.
- Install recovery: if setup fails, use the install/repair button again. The runtime is considered usable **only** when all setup stages completed and the ready marker was written.

## Potential caveats

- The old Roaming venv isn't moved, because Python virtual environments contain absolute paths and are not generally safe to relocate.
- You may have a temporary duplicate install after the first upgrade. Remove the old v0.1.0 environment explicitly after confirming that v0.2.0 analysis works.
- Checkpoint/model licensing and downloads are controlled by the upstream Maia3 project; see [THIRD_PARTY.md](THIRD_PARTY.md).
