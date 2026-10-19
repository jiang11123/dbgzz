# Runs an electron check script after cleaning up previous instances.
param([string]$Script = "")
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*doubaogzt*' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Set-Location 'D:\doubao\doubaogzt'
& .\node_modules\electron\dist\electron.exe $Script 2>&1 | Select-String 'VIEWS=|BEFORE=|CLICK_|ENTRY=|NO_DOUBAO|RESULT=|VIEW=|SHOT=|E2E'
exit $LASTEXITCODE
