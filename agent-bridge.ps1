$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$claudeLauncher = Join-Path $env:APPDATA 'npm\claude.cmd'
$run = Join-Path $env:TEMP ('agent-bridge-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $run | Out-Null

$proposal = Join-Path $run 'proposal.txt'
$review = Join-Path $run 'review.txt'
$final = Join-Path $run 'final.txt'

codex.cmd exec --sandbox read-only -o $proposal `
    'Propose a function signature and two tests for parsing a comma-separated list. In under 80 words, state your policy for empty entries.'
if ($LASTEXITCODE -ne 0) { throw 'Codex proposal failed.' }

$proposalText = Get-Content -Raw -Encoding UTF8 -LiteralPath $proposal
if ([string]::IsNullOrWhiteSpace($proposalText)) { throw "Proposal is empty. See $run" }

$reviewPrompt = "Review this proposal. Reply in under 60 words with one concrete change and why. Use text only.`n`n$proposalText"
$reviewPrompt | & $claudeLauncher -p | Set-Content -LiteralPath $review -Encoding UTF8
if ($LASTEXITCODE -ne 0) { throw 'Claude review failed.' }

$reviewText = Get-Content -Raw -Encoding UTF8 -LiteralPath $review
if ([string]::IsNullOrWhiteSpace($reviewText)) { throw "Review is empty. See $run" }

$revisionPrompt = "Revise this proposal in under 80 words. State what changed.`n`nProposal:`n$proposalText`n`nReview:`n$reviewText"
$revisionPrompt | codex.cmd exec --sandbox read-only -o $final -
if ($LASTEXITCODE -ne 0) { throw 'Codex revision failed.' }

Write-Host "Handoff files: $run"