#!/bin/sh
# Deploys Nuvio's schema, Edge Functions, and catalog avatars to a hosted Supabase project.

set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)
cd "$ROOT"

EDGE_FUNCTIONS="delete-account health-check tracker-tv-logins-exchange tv-logins-exchange"

usage() {
    cat <<'EOF'
Usage: ./serverless/supabase/deploy.sh [options]

Deploy Nuvio migrations, Edge Functions, and avatar assets to Supabase Cloud.

Options:
  --project-ref <ref>    Supabase project reference ID (e.g. abcdefghijklmnop)
  --db-password <pass>   Supabase Postgres database password (prefer SUPABASE_DB_PASSWORD env var)
  --catalog-url <url>    Optional custom default addon catalog URL
  --skip-avatars         Skip uploading assets/avatars/*.png to Storage
  --skip-verify          Skip live endpoint health verification
  -h, --help             Show this help message

Optional environment variables:
  SUPABASE_ACCESS_TOKEN      Personal access token for non-interactive CLI / Management API calls
  SUPABASE_PROJECT_REF       Same as --project-ref
  SUPABASE_DB_PASSWORD       Database password used by `supabase link`
  SUPABASE_PUBLISHABLE_KEY   Public/anon key (`sb_publishable_...` or JWT) for health checks
  SUPABASE_SERVICE_ROLE_KEY  Service-role/secret key for seeding Storage avatars
  DEFAULT_CATALOG_URL        Same as --catalog-url
EOF
}

die() {
    echo "ERROR: $*" >&2
    exit 1
}

PROJECT_REF=${SUPABASE_PROJECT_REF:-}
DB_PASSWORD=${SUPABASE_DB_PASSWORD:-}
CATALOG_URL=${DEFAULT_CATALOG_URL:-}
SKIP_AVATARS=0
SKIP_VERIFY=0

while [ $# -gt 0 ]; do
    case "$1" in
        --project-ref) [ $# -ge 2 ] || die "--project-ref requires a value"; PROJECT_REF=$2; shift 2 ;;
        --db-password) [ $# -ge 2 ] || die "--db-password requires a value"; DB_PASSWORD=$2; shift 2 ;;
        --catalog-url) [ $# -ge 2 ] || die "--catalog-url requires a value"; CATALOG_URL=$2; shift 2 ;;
        --skip-avatars) SKIP_AVATARS=1; shift ;;
        --skip-verify) SKIP_VERIFY=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "Unknown option: $1" ;;
    esac
done

if [ -z "$PROJECT_REF" ] && [ -t 0 ]; then
    printf 'Supabase Project Ref (from Project Settings -> General): '
    IFS= read -r PROJECT_REF || true
fi
[ -n "$PROJECT_REF" ] || die "Supabase Project Ref is required (--project-ref or SUPABASE_PROJECT_REF)"

if [ -z "$DB_PASSWORD" ] && [ -t 0 ]; then
    printf 'Supabase Database Password: '
    stty -echo 2>/dev/null || true
    IFS= read -r DB_PASSWORD || true
    stty echo 2>/dev/null || true
    printf '\n'
fi
[ -n "$DB_PASSWORD" ] || die "Database password is required (--db-password or SUPABASE_DB_PASSWORD)"

export SUPABASE_DB_PASSWORD="$DB_PASSWORD"

if command -v node >/dev/null 2>&1; then
    echo "Syncing supabase/ migrations and Edge Functions..."
    node "$ROOT/serverless/supabase/prepare.mjs"
elif [ ! -d "$ROOT/supabase/migrations" ]; then
    die "Node.js is missing and supabase/migrations does not exist"
fi

run_supabase() {
    if command -v supabase >/dev/null 2>&1; then
        supabase "$@"
    elif command -v npx >/dev/null 2>&1; then
        npx --yes supabase "$@"
    else
        die "Supabase CLI or npx is required. Install Supabase CLI: https://supabase.com/docs/guides/cli"
    fi
}

echo "Linking Supabase project $PROJECT_REF..."
run_supabase link --project-ref "$PROJECT_REF"

echo "Pushing database migrations..."
if run_supabase db push --help 2>&1 | grep -q -- '--remote'; then
    run_supabase db push --remote --yes
else
    run_supabase db push
fi

if [ -n "$CATALOG_URL" ]; then
    case "$CATALOG_URL" in
        http://*|https://*) ;;
        *) die "DEFAULT_CATALOG_URL must start with http:// or https://" ;;
    esac

    if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ] && command -v curl >/dev/null 2>&1; then
        escaped_catalog_url=$(printf '%s' "$CATALOG_URL" | sed "s/'/''/g")
        sql_payload=$(printf "INSERT INTO nuvio_private.instance_settings (key, value, updated_at) VALUES ('default_catalog_url', '%s', now()) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;" "$escaped_catalog_url")
        json_body=$(printf '{"query":"%s"}' "$(printf '%s' "$sql_payload" | sed 's/\\/\\\\/g; s/"/\\"/g')")
        echo "Updating nuvio_private.instance_settings default_catalog_url..."
        curl --fail-with-body -sS \
            -X POST \
            -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
            -H "Content-Type: application/json" \
            -d "$json_body" \
            "https://api.supabase.com/v1/projects/$PROJECT_REF/database/query" >/dev/null
    else
        echo ""
        echo "NOTE: Set SUPABASE_ACCESS_TOKEN or run this SQL in Supabase SQL Editor to apply DEFAULT_CATALOG_URL:"
        printf "  UPDATE nuvio_private.instance_settings SET value = '%s', updated_at = now() WHERE key = 'default_catalog_url';\n\n" "$CATALOG_URL"
    fi
fi

echo "Deploying Edge Functions (--use-api --no-verify-jwt)..."
for fn in $EDGE_FUNCTIONS; do
    echo "  -> $fn"
    run_supabase functions deploy "$fn" --project-ref "$PROJECT_REF" --use-api --no-verify-jwt
done

SUPABASE_URL="https://${PROJECT_REF}.supabase.co"
SERVICE_KEY=${SUPABASE_SERVICE_ROLE_KEY:-${SUPABASE_SECRET_KEY:-}}

if [ "$SKIP_AVATARS" -eq 0 ]; then
    if [ -z "$SERVICE_KEY" ] && [ -t 0 ]; then
        printf 'Supabase service_role / secret key to seed catalog avatars (leave blank to skip): '
        stty -echo 2>/dev/null || true
        IFS= read -r SERVICE_KEY || true
        stty echo 2>/dev/null || true
        printf '\n'
    fi

    if [ -n "$SERVICE_KEY" ]; then
        command -v curl >/dev/null 2>&1 || die "curl is required to seed avatars"
        storage_url="$SUPABASE_URL/storage/v1/object"
        asset_count=0
        uploaded_count=0
        echo "Seeding catalog avatars from assets/avatars/..."
        for asset in "$ROOT"/assets/avatars/*.png; do
            [ -f "$asset" ] || continue
            object_name=$(basename "$asset")
            asset_count=$((asset_count + 1))
            if curl -fsSI -o /dev/null "$storage_url/public/avatars/$object_name" 2>/dev/null; then
                continue
            fi
            curl --fail-with-body -sS -o /dev/null \
                -X POST \
                -H "apikey: $SERVICE_KEY" \
                -H "Authorization: Bearer $SERVICE_KEY" \
                -H "Content-Type: image/png" \
                -H "Cache-Control: public, max-age=31536000, immutable" \
                -H "x-upsert: true" \
                --data-binary "@$asset" \
                "$storage_url/avatars/$object_name"
            uploaded_count=$((uploaded_count + 1))
        done
        echo "OK  Avatars ready ($asset_count present, $uploaded_count uploaded)"
    else
        echo "Skipped avatar upload (no SUPABASE_SERVICE_ROLE_KEY provided)."
    fi
fi

PUBLISHABLE_KEY=${SUPABASE_PUBLISHABLE_KEY:-${SUPABASE_ANON_KEY:-}}
if [ "$SKIP_VERIFY" -eq 0 ] && [ -n "$PUBLISHABLE_KEY" ] && command -v curl >/dev/null 2>&1; then
    echo "Verifying live Supabase endpoints..."
    curl -fsS -o /dev/null -H "apikey: $PUBLISHABLE_KEY" "$SUPABASE_URL/auth/v1/health"
    echo "OK  Auth"
    curl -fsS -o /dev/null -X POST -H "apikey: $PUBLISHABLE_KEY" -H "Authorization: Bearer $PUBLISHABLE_KEY" "$SUPABASE_URL/rest/v1/rpc/health_ping"
    echo "OK  Database and REST API"
    curl -fsS -o /dev/null -H "apikey: $PUBLISHABLE_KEY" "$SUPABASE_URL/storage/v1/status"
    echo "OK  Storage"
    curl -fsS -o /dev/null -H "apikey: $PUBLISHABLE_KEY" "$SUPABASE_URL/functions/v1/health-check"
    echo "OK  Edge Functions"
fi

echo ""
echo "Supabase backend deployment complete."
echo "Next, configure your Cloudflare Discovery Worker variables:"
echo "  SUPABASE_URL=$SUPABASE_URL"
if [ -n "$PUBLISHABLE_KEY" ]; then
    echo "  SUPABASE_PUBLISHABLE_KEY=$PUBLISHABLE_KEY"
else
    echo "  SUPABASE_PUBLISHABLE_KEY=<copy from Supabase Dashboard -> Project Settings -> API Keys>"
fi
