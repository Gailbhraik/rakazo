#!/usr/bin/env bash
# Reconstruit l'interface d'Ashitaka et la met en service, depuis ce Deck.
#
# Pourquoi un conteneur jetable : `~/rakazo-src` n'a pas de `node_modules`, et
# les installer ici prendrait un gigaoctet et de longues minutes. L'image de
# l'application, elle, les porte déjà — on emprunte donc ses dépendances en
# montant par-dessus les sources de cet arbre, qui font foi.
#
# `package.json` n'est délibérément PAS monté : les dépendances de l'image
# doivent rester cohérentes avec son `node_modules`. Si une dépendance nouvelle
# apparaît, il faudra reconstruire l'image — le script le dira plutôt que de
# produire un bundle bancal.
#
# Les sources de `packages/contracts` sont montées aussi : l'interface appelle
# l'API à travers ces contrats, et un bundle construit contre ceux de l'image
# ignorerait toute procédure ou option ajoutée depuis dans cet arbre.
set -euo pipefail

SRC=/home/deck/rakazo-src
WEB=$SRC/apps/web
IMAGE=${IMAGE:-localhost/rakazo-app:host-routing}
OUT=$(mktemp -d /tmp/ashitaka-build.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

echo "→ construction dans un conteneur jetable ($IMAGE)"
# L'image déclare `USER=node`. En podman sans privilèges, c'est la racine du
# conteneur qui correspond à ton compte sur l'hôte ; tout autre utilisateur
# tombe dans la plage des sous-identifiants et ne peut pas écrire dans les
# sources montées, ce dont l'extraction Lingui a besoin.
podman run --rm --user 0 \
  -v "$WEB/src":/app/apps/web/src:rw \
  -v "$WEB/public":/app/apps/web/public:ro \
  -v "$WEB/index.html":/app/apps/web/index.html:ro \
  -v "$WEB/vite.config.ts":/app/apps/web/vite.config.ts:ro \
  -v "$WEB/lingui.config.ts":/app/apps/web/lingui.config.ts:ro \
  -v "$WEB/tsconfig.json":/app/apps/web/tsconfig.json:ro \
  -v "$SRC/packages/contracts/src":/app/packages/contracts/src:ro \
  -v "$OUT":/app/apps/web/dist:rw \
  -e NODE_ENV=production \
  --entrypoint sh \
  "$IMAGE" -lc '
    set -e
    cd /app
    # L extraction d abord : sans elle l interface affiche l identifiant du
    # message (« vfCo5O ») au lieu du texte.
    pnpm --filter @rakazo/web intl:extract
    pnpm --filter @rakazo/web intl:compile
    pnpm --filter @rakazo/web build
  '

if [ ! -f "$OUT/index.html" ]; then
  echo "✗ la construction n a produit aucun index.html — rien n est déployé" >&2
  exit 1
fi

echo "→ déploiement"
# On AJOUTE les morceaux et on ne bascule que index.html. Remplacer `dist` d un
# bloc casse tout appareil resté sur la version précédente : `vite preview`
# répond aux chemins inconnus par la bascule SPA, donc un morceau manquant
# renvoie index.html avec un code 200, que le navigateur ne peut pas exécuter
# comme du JavaScript.
avant=$(ls "$WEB/dist/assets" 2>/dev/null | wc -l)
mkdir -p "$WEB/dist/assets"
cp -r "$OUT/assets/." "$WEB/dist/assets/"
for f in index.html manifest.webmanifest favicon.svg apple-touch-icon.png; do
  [ -f "$OUT/$f" ] && cp "$OUT/$f" "$WEB/dist/$f"
done
echo "  morceaux : $avant → $(ls "$WEB/dist/assets" | wc -l)"
grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' "$WEB/dist/index.html" | head -1 | sed 's/^/  version servie : /'

podman restart rakazo-web-1 > /dev/null
sleep 8

echo "→ vérification"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
  -H 'Host: steamdeck.tail05b9b5.ts.net' http://127.0.0.1:5173/)
session=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
  -H 'Host: steamdeck.tail05b9b5.ts.net' http://127.0.0.1:5173/api/auth/get-session)
echo "  page : $code · session : $session"
if [ "$code" != "200" ] || [ "$session" != "200" ]; then
  echo "✗ l interface ne répond pas correctement — voir 'podman logs rakazo-web-1'" >&2
  exit 1
fi
echo "✓ en service sur https://steamdeck.tail05b9b5.ts.net"
