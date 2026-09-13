#!/usr/bin/env bash
# Recopie sur le Deck les transcriptions Claude Code de ce PC, pour que la page
# « Consommation Claude » du service de supervision les compte aussi.
#
# À lancer sur le PC (Git Bash). Le Deck ne vient pas chercher les fichiers
# lui-même : le PC n'expose pas de serveur SSH, et il est souvent éteint.
#
# Seuls les fichiers modifiés depuis la synchronisation précédente partent. Le
# témoin est posé AVANT de lister les fichiers et n'est validé qu'à la fin : un
# fichier qui grossit pendant l'envoi est donc plus récent que le témoin, et
# repartira au passage suivant au lieu d'être oublié.
#
# Les fichiers arrivent entiers, jamais en morceaux : le relevé du Deck reprend
# sa lecture là où il s'était arrêté, ce qui suppose que le début d'un fichier
# ne change pas — c'est le cas d'une transcription, qui ne fait que s'allonger.
set -euo pipefail

SRC="${CLAUDE_HOME:-$HOME/.claude}"
HOST="${DECK_HOST:-deck-codex}"
STAMP="$SRC/.deck-sync-stamp"

cd "$SRC"
touch "$STAMP.new"

if [ -f "$STAMP" ]; then
  mapfile -t files < <(find projects -type f -name '*.jsonl' -newer "$STAMP")
else
  mapfile -t files < <(find projects -type f -name '*.jsonl')
fi

remote_prepare='mkdir -p ~/.claude-sync/pc && chmod 700 ~/.claude-sync ~/.claude-sync/pc'

if [ "${#files[@]}" -gt 0 ]; then
  # Les transcriptions contiennent les conversations en entier : le répertoire
  # d'arrivée n'est lisible que du compte deck, comme ~/.claude sur le Deck.
  printf '%s\n' "${files[@]}" \
    | tar czf - -T - \
    | ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" "$remote_prepare && tar xzf - -C ~/.claude-sync/pc"
fi

# Le témoin distant est réécrit même sans fichier neuf : la page distingue ainsi
# « PC éteint depuis trois jours » de « PC allumé, rien de neuf ».
ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" \
  "$remote_prepare && date -u +%Y-%m-%dT%H:%M:%SZ > ~/.claude-sync/pc/.last-sync"

mv "$STAMP.new" "$STAMP"
echo "synchronisé : ${#files[@]} transcription(s) envoyée(s) vers $HOST"
