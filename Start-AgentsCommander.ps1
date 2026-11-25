param(
    [switch]$Doctor,
    [switch]$Demo
)

if ($Doctor -and $Demo) {
    throw 'Choose either -Doctor or -Demo.'
}

$launch = 'export PATH=~/.local/bin:/usr/local/bin:/usr/bin:/bin; exec node ~/agents-commander/dist/bin/agents-commander.js'
if ($Demo) {
    $launch += ' --demo'
} else {
    if ($Doctor) {
        $launch += ' --doctor'
    }
    $launch += ' /mnt/c/Users/PC/Documents/CCGPT'
}

wsl.exe -d Ubuntu-22.04 -- bash -lc $launch
exit $LASTEXITCODE
