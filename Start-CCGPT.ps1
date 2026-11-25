param([switch]$Demo, [switch]$SmokeTest, [switch]$LiveSmokeTest)

$ErrorActionPreference = 'Stop'
if ($LiveSmokeTest -and ($Demo -or $SmokeTest)) {
    throw 'Run the live smoke test without demo options.'
}
Add-Type -AssemblyName PresentationFramework

[xml]$layout = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="CCGPT" Width="840" Height="680" MinWidth="440" MinHeight="440"
        WindowStartupLocation="CenterScreen" Background="#101620" Foreground="#EEF3FA"
        FontFamily="Segoe UI" FontSize="15">
    <DockPanel Margin="28">
        <StackPanel DockPanel.Dock="Top" Margin="0,0,0,18">
            <TextBlock Text="CCGPT" FontSize="30" FontWeight="SemiBold"/>
            <TextBlock x:Name="RoomLabel" Foreground="#AEC0D7"/>
        </StackPanel>
        <StackPanel DockPanel.Dock="Bottom">
            <TextBlock x:Name="Status" Margin="0,12,0,8" Foreground="#AEC0D7"/>
            <DockPanel LastChildFill="True">
                <Button x:Name="Send" DockPanel.Dock="Right" Content="Send" Padding="20,8"
                        Margin="10,0,0,0" Background="#9BC6FF" Foreground="#101620"/>
                <TextBox x:Name="Composer" MinHeight="52" MaxHeight="150" Padding="10"
                         AcceptsReturn="True" TextWrapping="Wrap" VerticalScrollBarVisibility="Auto"
                         AutomationProperties.Name="Message" Background="#253346"
                         Foreground="#EEF3FA" CaretBrush="#EEF3FA" BorderBrush="#465B76"/>
            </DockPanel>
        </StackPanel>
        <Border Background="#192330" CornerRadius="10">
            <ScrollViewer x:Name="Scroll" VerticalScrollBarVisibility="Auto">
                <StackPanel x:Name="Transcript" Margin="18,16"/>
            </ScrollViewer>
        </Border>
    </DockPanel>
</Window>
'@

$window = [Windows.Markup.XamlReader]::Load([Xml.XmlNodeReader]::new($layout))
$scroll = $window.FindName('Scroll')
$transcript = $window.FindName('Transcript')
$composer = $window.FindName('Composer')
$send = $window.FindName('Send')
$status = $window.FindName('Status')
$idleStatus = 'Enter to send. Shift+Enter for a new line.'
$useStub = $Demo -or $SmokeTest
$window.FindName('RoomLabel').Text = if ($useStub) { 'Demo room | Simulated replies' } else { 'Chatroom | Codex and Claude' }
$status.Text = $idleStatus

function Add-Message([string]$speaker, [string]$message) {
    $card = [Windows.Controls.StackPanel]::new()
    $card.Margin = [Windows.Thickness]::new(0,0,0,14)
    $label = [Windows.Controls.TextBlock]::new()
    $label.Text = $speaker
    $label.FontWeight = [Windows.FontWeights]::SemiBold
    $label.Foreground = [Windows.Media.BrushConverter]::new().ConvertFromString('#9BC6FF')
    $body = [Windows.Controls.TextBox]::new()
    $body.Text = $message
    $body.IsReadOnly = $true
    $body.TextWrapping = 'Wrap'
    $body.BorderThickness = [Windows.Thickness]::new(0)
    $body.Padding = [Windows.Thickness]::new(0)
    $body.Background = [Windows.Media.Brushes]::Transparent
    $body.Foreground = $window.Foreground
    $null = $card.Children.Add($label)
    $null = $card.Children.Add($body)
    $null = $transcript.Children.Add($card)
    $scroll.ScrollToEnd()
}

$backend = [Diagnostics.Process]::new()
$backend.StartInfo.FileName = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$entryPoint = if ($useStub) { 'desktop-demo.mjs' } else { 'agent-terminal.mjs' }
$backend.StartInfo.Arguments = '"' + (Join-Path $PSScriptRoot $entryPoint) + '"'
if (!$useStub) { $backend.StartInfo.Arguments += ' --chat-json' }
$backend.StartInfo.WorkingDirectory = $PSScriptRoot
$backend.StartInfo.UseShellExecute = $false
$backend.StartInfo.CreateNoWindow = $true
$backend.StartInfo.RedirectStandardInput = $true
$backend.StartInfo.RedirectStandardOutput = $true
$backend.StartInfo.RedirectStandardError = $true
$backend.StartInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
$backend.StartInfo.StandardErrorEncoding = [Text.Encoding]::UTF8

function Send-Message {
    $message = $composer.Text.Trim()
    if (!$send.IsEnabled -or !$message -or $backend.HasExited) { return }
    try {
        $json = @{ text = $message } | ConvertTo-Json -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($json + [char]10)
        $backend.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
        $backend.StandardInput.BaseStream.Flush()
        $send.IsEnabled = $false
        $status.Text = 'Waiting for the room...'
    } catch {
        Add-Message 'Room' $_.Exception.Message
    }
}

$timer = [Windows.Threading.DispatcherTimer]::new()
$timer.Interval = [TimeSpan]::FromMilliseconds(80)
$timer.Add_Tick({
    while ($script:nextLine.IsCompleted) {
        $line = $script:nextLine.GetAwaiter().GetResult()
        if ($null -eq $line) {
            $timer.Stop()
            $send.IsEnabled = $false
            $status.Text = 'Chat backend disconnected.'
            return
        }
        $script:nextLine = $backend.StandardOutput.ReadLineAsync()
        try {
            $event = ConvertFrom-Json -InputObject $line
            if ($event.done) {
                $status.Text = $idleStatus
                $send.IsEnabled = $true
            } elseif ($event.speaker) {
                $speaker = switch ($event.speaker) {
                    'user' { 'You' }
                    'codex' { 'Codex' }
                    'claude' { 'Claude' }
                    'system' { 'Room' }
                    default { $event.speaker }
                }
                Add-Message $speaker $event.text
                if ($event.speaker -eq 'user' -and $composer.Text.Trim() -ceq $event.text) {
                    $composer.Clear()
                }
            }
        } catch {
            Add-Message 'Room' 'The chat backend returned an invalid event.'
        }
    }
})

$send.Add_Click({ Send-Message })
$composer.Add_PreviewKeyDown({
    param($sender, $event)
    if ($event.Key -eq 'Return' -and [Windows.Input.Keyboard]::Modifiers -eq 'None') {
        $event.Handled = $true
        Send-Message
    }
})
$window.Add_ContentRendered({ $null = $composer.Focus() })

$started = $false
try {
    $started = $backend.Start()
    $script:nextLine = $backend.StandardOutput.ReadLineAsync()
    $null = $backend.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
    $timer.Start()
    if ($SmokeTest -or $LiveSmokeTest) {
        $sample = if ($SmokeTest) { 'Smoke test ' + [char]0xE9 } else {
            'Desktop smoke test. Reply once with your name. If you already replied, PASS.'
        }
        $composer.Text = $sample
        $send.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
        $deadline = [DateTime]::UtcNow.AddSeconds($(if ($SmokeTest) { 5 } else { 60 }))
        while (!$send.IsEnabled -and [DateTime]::UtcNow -lt $deadline) {
            $window.Dispatcher.Invoke([Action]{}, [Windows.Threading.DispatcherPriority]::Background)
            Start-Sleep -Milliseconds 25
        }
        $speakers = foreach ($card in $transcript.Children) { $card.Children[0].Text }
        if ($LiveSmokeTest) {
            foreach ($card in $transcript.Children) {
                Write-Output ('[' + $card.Children[0].Text + '] ' + $card.Children[1].Text)
            }
        }
        if (!$send.IsEnabled -or $speakers -notcontains 'Codex' -or $speakers -notcontains 'Claude' -or
            ($SmokeTest -and !$transcript.Children[2].Children[1].Text.Contains($sample))) {
            throw 'Desktop smoke test did not receive the expected transcript.'
        }
        Write-Output 'Desktop smoke test passed.'
    } else {
        $null = $window.ShowDialog()
    }
} finally {
    $timer.Stop()
    if ($started -and !$backend.HasExited) {
        $backend.StandardInput.Close()
        if (!$backend.WaitForExit(1500)) { $backend.Kill() }
    }
    $backend.Dispose()
}
