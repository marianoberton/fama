<#
.SYNOPSIS
  Smoke-test the Chatwoot webhook endpoint against every fixture.

.DESCRIPTION
  POSTs each tests/fixtures/webhook/*.json file to
  <BaseUrl>/api/v1/webhooks/chatwoot/<Token> and prints `<fixture>: <status>`.

  Fixtures contain a `_meta` envelope with the expected outcome — that block
  is stripped before sending so the body looks like a real Chatwoot payload.

  This is a manual sanity check for once the server handler is wired up.
  The filter is exercised in unit tests; this script exists to validate the
  HTTP plumbing end-to-end.

.PARAMETER BaseUrl
  Base URL of the running FAMA service. Default: http://localhost:4111.

.PARAMETER Token
  Path token to put in the URL. Required. For most fixtures use the value of
  CHATWOOT_PATH_TOKEN from your .env so the body passes rule 1; fixture
  01-invalid-path-token.json is intentionally testing the rejection.

.EXAMPLE
  .\scripts\smoke-webhook.ps1 -Token <real-token-from-env>

.EXAMPLE
  .\scripts\smoke-webhook.ps1 -BaseUrl https://fama.example.com -Token <token>
#>

[CmdletBinding()]
param(
    [string] $BaseUrl = 'http://localhost:4111',
    [Parameter(Mandatory = $true)]
    [string] $Token
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$fixturesDir = Join-Path (Split-Path -Parent $scriptDir) 'tests\fixtures\webhook'

if (-not (Test-Path $fixturesDir)) {
    Write-Error "Fixtures directory not found: $fixturesDir"
    exit 1
}

$endpoint = "$BaseUrl/api/v1/webhooks/chatwoot/$Token"
Write-Host "POST → $endpoint" -ForegroundColor Cyan
Write-Host ""

$fixtures = Get-ChildItem -Path $fixturesDir -Filter '*.json' | Sort-Object Name

foreach ($fixture in $fixtures) {
    $raw = Get-Content -Path $fixture.FullName -Raw
    $payload = $raw | ConvertFrom-Json

    # Strip the _meta envelope so what we send looks like a real Chatwoot body.
    if ($null -ne $payload.PSObject.Properties['_meta']) {
        $payload.PSObject.Properties.Remove('_meta')
    }

    $body = $payload | ConvertTo-Json -Depth 20

    try {
        $response = Invoke-WebRequest `
            -Uri $endpoint `
            -Method POST `
            -Body $body `
            -ContentType 'application/json' `
            -UseBasicParsing `
            -ErrorAction Stop

        $status = $response.StatusCode
    }
    catch [System.Net.WebException] {
        if ($_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
        }
        else {
            $status = 'ERR'
        }
    }
    catch {
        if ($_.Exception.Response.StatusCode.value__) {
            $status = [int]$_.Exception.Response.StatusCode.value__
        }
        else {
            $status = "ERR ($($_.Exception.Message))"
        }
    }

    Write-Host ("{0}: {1}" -f $fixture.Name, $status)
}
