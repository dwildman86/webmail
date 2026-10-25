#!/bin/sh
# Makes dist/webmail-<version>.zip: what customers upload to their hosting. No tests, no Composer files, no config.
set -eu
cd "$(dirname "$0")"

VERSION=$(sed -n "s/.*const VERSION = '\([^']*\)'.*/\1/p" app/App.php)
[ -n "$VERSION" ] || { echo "Can't read the version from app/App.php" >&2; exit 1; }
# The service worker caches files by version: keep it in step, or installed apps keep the old interface.
grep -q "const VERSION = \"wm-$VERSION\"" sw.js || { echo "sw.js VERSION isn't wm-$VERSION" >&2; exit 1; }
grep -q "v=$VERSION\"" sw.js || { echo "sw.js caches assets for another version than $VERSION" >&2; exit 1; }

for f in app/*.php api.php index.php install.php install-cli.php manifest.php webhook.php; do php -l "$f" >/dev/null; done

OUT="dist/webmail-$VERSION.zip"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/webmail" dist
cp -R app assets storage api.php index.php install.php install-cli.php manifest.php webhook.php sw.js .htaccess .user.ini README.md "$STAGE/webmail/"
# storage/ holds only its guard files in the zip.
find "$STAGE/webmail/storage" -mindepth 1 ! -name .htaccess ! -name index.html -exec rm -rf {} +
rm -f "$OUT"
(cd "$STAGE" && zip -qr -X "$OLDPWD/$OUT" webmail)
echo "$OUT ($(du -h "$OUT" | cut -f1))"
