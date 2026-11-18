<#
.SYNOPSIS
Deploys Nuvio's schema migrations, Edge Functions, and catalog avatars to a hosted Supabase project.
#>
[CmdletBinding()]
param(
    [string]$ProjectRef = $env:SUPABASE_PROJECT_REF,
    [string]$DbPassword = $env:SUPABASE_DB_PASSWORD,
    [string]$CatalogUrl = $env:DEFAULT_CATALOG_URL,
    [string]$PublishableKey = $(if ($env:SUPABASE_PUBLISHABLE_KEY) { $env:SUPABASE_PUBLISHABLE_KEY } else { $env:SUPABASE_ANON_KEY }),
    [string]$ServiceRoleKey = $(if ($env:SUPABASE_SERVICE_ROLE_KEY) { $env:SUPABASE_SERVICE_ROLE_KEY } else { $env:SUPABASE_SECRET_KEY }),
    [switch]$SkipAvatars,
    [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Push-Location $Root
try {
    $EdgeFunctions = @(
        "delete-account",
        "health-check",
        "tracker-tv-logins-exchange",
        "tv-logins-exchange"
    )

    if ([string]::IsNullOrWhiteSpace($ProjectRef)) {
        $ProjectRef = Read-Host "Supabase Project Ref (from Project Settings -> General)"
    }
    if ([string]::IsNullOrWhiteSpace($ProjectRef)) {
        throw "Supabase Project Ref is required."
    }

    if ([string]::IsNullOrWhiteSpace($DbPassword)) {
        $securePwd = Read-Host "Supabase Database Password" -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePwd)
        try {
            $DbPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }
    if ([string]::IsNullOrWhiteSpace($DbPassword)) {
        throw "Supabase Database Password is required."
    }

    $env:SUPABASE_DB_PASSWORD = $DbPassword

    if (Get-Command node -ErrorAction SilentlyContinue) {
        Write-Host "Syncing supabase/ migrations and Edge Functions..."
        & node (Join-Path $Root "serverless\supabase\prepare.mjs")
        if ($LASTEXITCODE -ne 0) { throw "prepare.mjs failed" }
    } elseif (-not (Test-Path (Join-Path $Root "supabase\migrations"))) {
        throw "Node.js is not installed and supabase/migrations does not exist."
    }

    $UseNpx = $false
    if (-not (Get-Command supabase -ErrorAction SilentlyContinue)) {
        if (Get-Command npx -ErrorAction SilentlyContinue) {
            $UseNpx = $true
        } else {
            throw "Supabase CLI or npx is required. Install Supabase CLI: https://supabase.com/docs/guides/cli"
        }
    }

    function Invoke-SupabaseCli {
        param([string[]]$CliArgs)
        if ($UseNpx) {
            & npx --yes supabase @CliArgs
        } else {
            & supabase @CliArgs
        }
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed: supabase $($CliArgs -join ' ')"
        }
    }

    Write-Host "Linking Supabase project $ProjectRef..."
    Invoke-SupabaseCli -CliArgs @("link", "--project-ref", $ProjectRef)

    $pushHelp = if ($UseNpx) {
        (& npx --yes supabase db push --help 2>&1) -join "`n"
    } else {
        (& supabase db push --help 2>&1) -join "`n"
    }
    Write-Host "Pushing database migrations..."
    if ($pushHelp -match "--remote") {
        Invoke-SupabaseCli -CliArgs @("db", "push", "--remote", "--yes")
    } else {
        Invoke-SupabaseCli -CliArgs @("db", "push")
    }

    if (-not [string]::IsNullOrWhiteSpace($CatalogUrl)) {
        if ($CatalogUrl -notmatch "^https?://") {
            throw "DEFAULT_CATALOG_URL must start with http:// or https://"
        }
        if (-not [string]::IsNullOrWhiteSpace($env:SUPABASE_ACCESS_TOKEN)) {
            Write-Host "Updating nuvio_private.instance_settings default_catalog_url..."
            $escapedCatalogUrl = $CatalogUrl.Replace("'", "''")
            $sql = "INSERT INTO nuvio_private.instance_settings (key, value, updated_at) VALUES ('default_catalog_url', '$escapedCatalogUrl', now()) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;"
            $body = @{ query = $sql } | ConvertTo-Json
            Invoke-RestMethod -Method Post `
                -Uri "https://api.supabase.com/v1/projects/$ProjectRef/database/query" `
                -Headers @{ Authorization = "Bearer $($env:SUPABASE_ACCESS_TOKEN)"; "Content-Type" = "application/json" } `
                -Body $body | Out-Null
        } else {
            Write-Warning "Set SUPABASE_ACCESS_TOKEN or run this SQL in Supabase SQL Editor to apply DEFAULT_CATALOG_URL:"
            Write-Host "  UPDATE nuvio_private.instance_settings SET value = '$($CatalogUrl.Replace("'", "''"))', updated_at = now() WHERE key = 'default_catalog_url';"
        }
    }

    Write-Host "Deploying Edge Functions (--use-api --no-verify-jwt)..."
    foreach ($fn in $EdgeFunctions) {
        Write-Host "  -> $fn"
        Invoke-SupabaseCli -CliArgs @("functions", "deploy", $fn, "--project-ref", $ProjectRef, "--use-api", "--no-verify-jwt")
    }

    $SupabaseUrl = "https://$ProjectRef.supabase.co"

    if (-not $SkipAvatars) {
        if ([string]::IsNullOrWhiteSpace($ServiceRoleKey)) {
            $secureKey = Read-Host "Supabase service_role / secret key to seed catalog avatars (press Enter to skip)" -AsSecureString
            $bstrKey = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
            try {
                $ServiceRoleKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstrKey)
            } finally {
                [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstrKey)
            }
        }

        if (-not [string]::IsNullOrWhiteSpace($ServiceRoleKey)) {
            $avatarFiles = Get-ChildItem -Path (Join-Path $Root "assets\avatars") -Filter "*.png" | Sort-Object Name
            $uploaded = 0
            Write-Host "Seeding $($avatarFiles.Count) catalog avatars from assets/avatars/..."
            foreach ($file in $avatarFiles) {
                $publicUrl = "$SupabaseUrl/storage/v1/object/public/avatars/$($file.Name)"
                $exists = $false
                try {
                    $head = Invoke-WebRequest -Method Head -Uri $publicUrl -UseBasicParsing -ErrorAction Stop
                    if ($head.StatusCode -ge 200 -and $head.StatusCode -lt 300) {
                        $exists = $true
                    }
                } catch {
                    $exists = $false
                }
                if ($exists) { continue }

                Invoke-RestMethod -Method Post `
                    -Uri "$SupabaseUrl/storage/v1/object/avatars/$($file.Name)" `
                    -Headers @{
                        apikey          = $ServiceRoleKey
                        Authorization   = "Bearer $ServiceRoleKey"
                        "Cache-Control" = "public, max-age=31536000, immutable"
                        "x-upsert"      = "true"
                    } `
                    -ContentType "image/png" `
                    -InFile $file.FullName | Out-Null
                $uploaded++
            }
            Write-Host "OK  Avatars ready ($($avatarFiles.Count) present, $uploaded uploaded)"
        } else {
            Write-Host "Skipped avatar upload (no service role key provided)."
        }
    }

    if (-not $SkipVerify -and -not [string]::IsNullOrWhiteSpace($PublishableKey)) {
        Write-Host "Verifying live Supabase endpoints..."
        Invoke-WebRequest -Uri "$SupabaseUrl/auth/v1/health" -Headers @{ apikey = $PublishableKey } -UseBasicParsing | Out-Null
        Write-Host "OK  Auth"
        Invoke-WebRequest -Method Post -Uri "$SupabaseUrl/rest/v1/rpc/health_ping" -Headers @{ apikey = $PublishableKey; Authorization = "Bearer $PublishableKey" } -UseBasicParsing | Out-Null
        Write-Host "OK  Database and REST API"
        Invoke-WebRequest -Uri "$SupabaseUrl/storage/v1/status" -Headers @{ apikey = $PublishableKey } -UseBasicParsing | Out-Null
        Write-Host "OK  Storage"
        Invoke-WebRequest -Uri "$SupabaseUrl/functions/v1/health-check" -Headers @{ apikey = $PublishableKey } -UseBasicParsing | Out-Null
        Write-Host "OK  Edge Functions"
    }

    Write-Host ""
    Write-Host "Supabase backend deployment complete."
    Write-Host "Next, configure your Cloudflare Discovery Worker variables:"
    Write-Host "  SUPABASE_URL=$SupabaseUrl"
    if (-not [string]::IsNullOrWhiteSpace($PublishableKey)) {
        Write-Host "  SUPABASE_PUBLISHABLE_KEY=$PublishableKey"
    } else {
        Write-Host "  SUPABASE_PUBLISHABLE_KEY=<copy from Supabase Dashboard -> Project Settings -> API Keys>"
    }
} finally {
    Pop-Location
}
