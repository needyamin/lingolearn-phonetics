# LingoLearn Lens - selection capturer.
# Saves the current clipboard text, clears the clipboard, sends Ctrl+C to the
# foreground app, waits briefly for new clipboard text, restores the original
# clipboard, then prints EXACTLY ONE line: base64(UTF8(JSON)) where JSON is
# {"ok":true,"text":"..."} on success or {"ok":false} when no selection was
# captured. Total runtime stays well under 1.5s.

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
Add-Type -AssemblyName System.Windows.Forms

if (-not ('LL.LLKeys' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace LL {
    public static class LLKeys {
        [DllImport("user32.dll")]
        public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
        public const uint KEYEVENTF_KEYUP = 0x0002;
        public const byte VK_CONTROL = 0x11;
        public const byte VK_C = 0x43;
    }
}
"@
}

$original = ''
try { $original = [string][System.Windows.Forms.Clipboard]::GetText() } catch {}

$success = $false
$captured = ''
try {
    try { [System.Windows.Forms.Clipboard]::Clear() } catch {}

    # Simulate Ctrl+C on the foreground window.
    [LL.LLKeys]::keybd_event([LL.LLKeys]::VK_CONTROL, 0, 0, [UIntPtr]::Zero)
    [LL.LLKeys]::keybd_event([LL.LLKeys]::VK_C, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [LL.LLKeys]::keybd_event([LL.LLKeys]::VK_C, 0, [LL.LLKeys]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
    [LL.LLKeys]::keybd_event([LL.LLKeys]::VK_CONTROL, 0, [LL.LLKeys]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)

    # The clipboard was cleared first, so ANY non-empty text that appears is the
    # selection — including text identical to what was there before.
    $cleared = -not [string][System.Windows.Forms.Clipboard]::GetText()
    $resends = 0
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt 1200) {
        Start-Sleep -Milliseconds 30
        $t = ''
        try { $t = [string][System.Windows.Forms.Clipboard]::GetText() } catch {}
        if ($t -and ($cleared -or ($t -ne $original))) {
            $captured = $t
            $success = $true
            break
        }
        if ($resends -eq 0 -and $sw.ElapsedMilliseconds -ge 300) {
            $resends = 1
            [LL.LLKeys]::keybd_event([LL.LLKeys]::VK_CONTROL, 0, 0, [UIntPtr]::Zero)
            [LL.LLKeys]::keybd_event([LL.LLKeys]::VK_C, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 35
            [LL.LLKeys]::keybd_event([LL.LLKeys]::VK_C, 0, [LL.LLKeys]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
            [LL.LLKeys]::keybd_event([LL.LLKeys]::VK_CONTROL, 0, [LL.LLKeys]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
        }
    }
} catch {
    $success = $false
} finally {
    # Restore the previous clipboard only when nothing changed after us. If the
    # user copied something during the capture window, keep their text.
    try {
        $after = ''
        try { $after = [string][System.Windows.Forms.Clipboard]::GetText() } catch {}
        $changedByUser = $after -and ($after -ne $captured) -and ($after -ne $original)
        if ($changedByUser) {
            # Keep the user's fresh copy.
        } elseif ($original) {
            [System.Windows.Forms.Clipboard]::SetText($original)
        } else {
            try { [System.Windows.Forms.Clipboard]::Clear() } catch {}
        }
    } catch {}
}

$payload = @{ ok = $success; text = $captured } | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
[Console]::Out.WriteLine([Convert]::ToBase64String($bytes))
[Console]::Out.Flush()
