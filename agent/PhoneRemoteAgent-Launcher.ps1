param(
  [string]$ServerUrl = $env:PHONE_REMOTE_SERVER_URL
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
if ([string]::IsNullOrWhiteSpace($ServerUrl)) {
  $ServerUrl = "https://your-domain.example"
}

if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne "STA") {
  $self = $MyInvocation.MyCommand.Path
  Start-Process powershell.exe -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-STA",
    "-WindowStyle", "Hidden",
    "-File", "`"$self`"",
    "`"$ServerUrl`""
  ) -WindowStyle Hidden
  exit
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:ServerUrl = $ServerUrl.TrimEnd("/")
$script:BaseDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:AgentScript = Join-Path $script:BaseDir "pc-agent.ps1"
$script:LogDir = Join-Path $env:LOCALAPPDATA "PhoneRemoteAgent\logs"
$script:AgentProcess = $null
$script:StdOutPath = ""
$script:StdErrPath = ""
$script:CurrentPin = "------"
$script:LastStartedAt = Get-Date

if (-not (Test-Path -LiteralPath $script:LogDir)) {
  New-Item -ItemType Directory -Path $script:LogDir -Force | Out-Null
}

function New-Color($Hex) {
  return [System.Drawing.ColorTranslator]::FromHtml($Hex)
}

function Set-ControlFont($Control, [single]$Size, [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular) {
  $Control.Font = New-Object System.Drawing.Font("Segoe UI", $Size, $Style)
}

function Update-Status([string]$Text, [string]$Color = "#64748b") {
  $statusLabel.Text = $Text
  $statusLabel.ForeColor = New-Color $Color
  $trayText = "Phone Remote Agent - $Text"
  if ($trayText.Length -gt 63) {
    $trayText = $trayText.Substring(0, 60) + "..."
  }
  try { $notifyIcon.Text = $trayText } catch {}
}

function Read-AgentOutput {
  $text = ""
  if ($script:StdOutPath -and (Test-Path -LiteralPath $script:StdOutPath)) {
    try { $text += Get-Content -Raw -LiteralPath $script:StdOutPath -ErrorAction SilentlyContinue } catch {}
  }
  if ($script:StdErrPath -and (Test-Path -LiteralPath $script:StdErrPath)) {
    try { $text += "`n" + (Get-Content -Raw -LiteralPath $script:StdErrPath -ErrorAction SilentlyContinue) } catch {}
  }
  return $text
}

function Start-Agent {
  if (-not (Test-Path -LiteralPath $script:AgentScript)) {
    Update-Status "Missing pc-agent.ps1" "#b42318"
    return
  }

  if ($script:AgentProcess -and -not $script:AgentProcess.HasExited) {
    return
  }

  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $script:StdOutPath = Join-Path $script:LogDir "agent-$stamp.out.log"
  $script:StdErrPath = Join-Path $script:LogDir "agent-$stamp.err.log"
  $script:CurrentPin = "------"
  $pinLabel.Text = $script:CurrentPin
  $script:LastStartedAt = Get-Date
  Update-Status "Connecting to server..." "#0f536f"

  $args = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$script:AgentScript`"",
    "`"$script:ServerUrl`""
  )

  try {
    $script:AgentProcess = Start-Process powershell.exe `
      -ArgumentList $args `
      -WorkingDirectory $script:BaseDir `
      -WindowStyle Hidden `
      -RedirectStandardOutput $script:StdOutPath `
      -RedirectStandardError $script:StdErrPath `
      -PassThru
  } catch {
    Update-Status "Failed to start agent: $($_.Exception.Message)" "#b42318"
  }
}

function Stop-Agent {
  if ($script:AgentProcess -and -not $script:AgentProcess.HasExited) {
    try {
      Stop-Process -Id $script:AgentProcess.Id -Force -ErrorAction SilentlyContinue
    } catch {}
  }
  Update-Status "Stopped" "#b42318"
}

function Restart-Agent {
  Stop-Agent
  Start-Sleep -Milliseconds 400
  Start-Agent
}

function Copy-Pin {
  if ($script:CurrentPin -match "^\d{6}$") {
    [System.Windows.Forms.Clipboard]::SetText($script:CurrentPin)
    Update-Status "PIN copied. Enter it on your phone." "#166b8f"
  }
}

function Refresh-AgentState {
  if ($script:AgentProcess -and $script:AgentProcess.HasExited) {
    $text = Read-AgentOutput
    if ($text -match "Connection error|error|failed|Cannot|Exception") {
      Update-Status "Agent stopped. Click Restart." "#b42318"
    } else {
      Update-Status "Agent stopped" "#b42318"
    }
    return
  }

  $output = Read-AgentOutput
  $pinMatches = [regex]::Matches($output, "PIN:\s*(\d{6})")
  if ($pinMatches.Count -gt 0) {
    $newPin = $pinMatches[$pinMatches.Count - 1].Groups[1].Value
    if ($newPin -ne $script:CurrentPin) {
      $script:CurrentPin = $newPin
      $pinLabel.Text = $script:CurrentPin
      $copyButton.Enabled = $true
      Update-Status "Ready. Enter this PIN on your phone." "#166b8f"
      try {
        $notifyIcon.BalloonTipTitle = "Phone Remote Agent"
        $notifyIcon.BalloonTipText = "New pairing PIN: $script:CurrentPin"
        $notifyIcon.ShowBalloonTip(2500)
      } catch {}
    }
    return
  }

  if ($script:AgentProcess -and -not $script:AgentProcess.HasExited) {
    $seconds = [int]((Get-Date) - $script:LastStartedAt).TotalSeconds
    if ($seconds -gt 12) {
      Update-Status "Still connecting..." "#8a5a12"
    }
  }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Phone Remote Agent"
$form.StartPosition = "CenterScreen"
$form.Size = New-Object System.Drawing.Size(460, 430)
$form.MinimumSize = New-Object System.Drawing.Size(460, 430)
$form.MaximizeBox = $false
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedSingle
$form.BackColor = New-Color "#f4f6f8"
Set-ControlFont $form 10

$card = New-Object System.Windows.Forms.Panel
$card.Location = New-Object System.Drawing.Point(18, 18)
$card.Size = New-Object System.Drawing.Size(408, 344)
$card.BackColor = [System.Drawing.Color]::White
$card.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$form.Controls.Add($card)

$badge = New-Object System.Windows.Forms.Label
$badge.Location = New-Object System.Drawing.Point(24, 24)
$badge.Size = New-Object System.Drawing.Size(52, 52)
$badge.Text = [string][char]0x2713
$badge.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$badge.ForeColor = [System.Drawing.Color]::White
$badge.BackColor = New-Color "#35c28b"
Set-ControlFont $badge 24 ([System.Drawing.FontStyle]::Bold)
$card.Controls.Add($badge)

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Location = New-Object System.Drawing.Point(92, 22)
$titleLabel.Size = New-Object System.Drawing.Size(280, 30)
$titleLabel.Text = "Phone Remote Agent"
$titleLabel.ForeColor = New-Color "#17212b"
Set-ControlFont $titleLabel 18 ([System.Drawing.FontStyle]::Bold)
$card.Controls.Add($titleLabel)

$subtitleLabel = New-Object System.Windows.Forms.Label
$subtitleLabel.Location = New-Object System.Drawing.Point(94, 55)
$subtitleLabel.Size = New-Object System.Drawing.Size(280, 22)
$subtitleLabel.Text = "Background file access bridge"
$subtitleLabel.ForeColor = New-Color "#64748b"
Set-ControlFont $subtitleLabel 10
$card.Controls.Add($subtitleLabel)

$pinCaption = New-Object System.Windows.Forms.Label
$pinCaption.Location = New-Object System.Drawing.Point(24, 106)
$pinCaption.Size = New-Object System.Drawing.Size(356, 24)
$pinCaption.Text = "Pairing PIN"
$pinCaption.ForeColor = New-Color "#166b8f"
Set-ControlFont $pinCaption 11 ([System.Drawing.FontStyle]::Bold)
$card.Controls.Add($pinCaption)

$pinPanel = New-Object System.Windows.Forms.Panel
$pinPanel.Location = New-Object System.Drawing.Point(24, 136)
$pinPanel.Size = New-Object System.Drawing.Size(356, 78)
$pinPanel.BackColor = New-Color "#e8f3f7"
$pinPanel.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$card.Controls.Add($pinPanel)

$pinLabel = New-Object System.Windows.Forms.Label
$pinLabel.Location = New-Object System.Drawing.Point(0, 7)
$pinLabel.Size = New-Object System.Drawing.Size(354, 62)
$pinLabel.Text = "------"
$pinLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$pinLabel.ForeColor = New-Color "#0f536f"
Set-ControlFont $pinLabel 34 ([System.Drawing.FontStyle]::Bold)
$pinPanel.Controls.Add($pinLabel)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Location = New-Object System.Drawing.Point(24, 228)
$statusLabel.Size = New-Object System.Drawing.Size(356, 24)
$statusLabel.Text = "Starting..."
$statusLabel.ForeColor = New-Color "#64748b"
Set-ControlFont $statusLabel 10
$card.Controls.Add($statusLabel)

$hintLabel = New-Object System.Windows.Forms.Label
$hintLabel.Location = New-Object System.Drawing.Point(24, 255)
$hintLabel.Size = New-Object System.Drawing.Size(356, 34)
$hintLabel.Text = "Open the phone site and enter this PIN. You can close this window to keep the agent in the tray."
$hintLabel.ForeColor = New-Color "#64748b"
Set-ControlFont $hintLabel 9
$card.Controls.Add($hintLabel)

$copyButton = New-Object System.Windows.Forms.Button
$copyButton.Location = New-Object System.Drawing.Point(24, 300)
$copyButton.Size = New-Object System.Drawing.Size(104, 36)
$copyButton.Text = "Copy PIN"
$copyButton.Enabled = $false
$copyButton.BackColor = New-Color "#166b8f"
$copyButton.ForeColor = [System.Drawing.Color]::White
Set-ControlFont $copyButton 10 ([System.Drawing.FontStyle]::Bold)
$copyButton.Add_Click({ Copy-Pin })
$card.Controls.Add($copyButton)

$openButton = New-Object System.Windows.Forms.Button
$openButton.Location = New-Object System.Drawing.Point(138, 300)
$openButton.Size = New-Object System.Drawing.Size(112, 36)
$openButton.Text = "Open Site"
$openButton.BackColor = New-Color "#e8f3f7"
$openButton.ForeColor = New-Color "#0f536f"
Set-ControlFont $openButton 10 ([System.Drawing.FontStyle]::Bold)
$openButton.Add_Click({ Start-Process $script:ServerUrl })
$card.Controls.Add($openButton)

$restartButton = New-Object System.Windows.Forms.Button
$restartButton.Location = New-Object System.Drawing.Point(260, 300)
$restartButton.Size = New-Object System.Drawing.Size(80, 36)
$restartButton.Text = "Restart"
$restartButton.BackColor = New-Color "#edf1f4"
$restartButton.ForeColor = New-Color "#17212b"
Set-ControlFont $restartButton 10 ([System.Drawing.FontStyle]::Bold)
$restartButton.Add_Click({ Restart-Agent })
$card.Controls.Add($restartButton)

$stopButton = New-Object System.Windows.Forms.Button
$stopButton.Location = New-Object System.Drawing.Point(346, 300)
$stopButton.Size = New-Object System.Drawing.Size(34, 36)
$stopButton.Text = "X"
$stopButton.BackColor = New-Color "#f7e8e6"
$stopButton.ForeColor = New-Color "#b42318"
Set-ControlFont $stopButton 10 ([System.Drawing.FontStyle]::Bold)
$stopButton.Add_Click({
  $script:AllowClose = $true
  Stop-Agent
  $notifyIcon.Visible = $false
  $form.Close()
})
$card.Controls.Add($stopButton)

$footer = New-Object System.Windows.Forms.Label
$footer.Location = New-Object System.Drawing.Point(20, 372)
$footer.Size = New-Object System.Drawing.Size(410, 24)
$footer.Text = "Read-only access. The PIN changes whenever the agent reconnects."
$footer.ForeColor = New-Color "#64748b"
Set-ControlFont $footer 8.5
$form.Controls.Add($footer)

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$showItem = $menu.Items.Add("Show")
$copyItem = $menu.Items.Add("Copy PIN")
$restartItem = $menu.Items.Add("Restart")
$stopItem = $menu.Items.Add("Stop and Exit")

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
$notifyIcon.Text = "Phone Remote Agent"
$notifyIcon.Visible = $true
$notifyIcon.ContextMenuStrip = $menu

$showAction = {
  $form.Show()
  $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
  $form.Activate()
}
$showItem.Add_Click($showAction)
$notifyIcon.Add_DoubleClick($showAction)
$copyItem.Add_Click({ Copy-Pin })
$restartItem.Add_Click({ Restart-Agent })
$stopItem.Add_Click({
  $script:AllowClose = $true
  Stop-Agent
  $notifyIcon.Visible = $false
  $form.Close()
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 700
$timer.Add_Tick({ Refresh-AgentState })

$form.Add_Shown({
  Start-Agent
  $timer.Start()
})

$script:AllowClose = $false

$form.Add_FormClosing({
  param($sender, $eventArgs)
  if (-not $script:AllowClose) {
    $eventArgs.Cancel = $true
    $form.Hide()
    try {
      $notifyIcon.BalloonTipTitle = "Phone Remote Agent"
      $notifyIcon.BalloonTipText = "Still running in the background. Double-click the tray icon to show the PIN."
      $notifyIcon.ShowBalloonTip(2500)
    } catch {}
  }
})

[void][System.Windows.Forms.Application]::Run($form)
