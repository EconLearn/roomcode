#!/bin/zsh
# Double-click this file in Finder. It asks for the two codes from the Nexconn
# console, saves them on this Mac (.env, never committed) and in the Azure site's
# private settings. Nothing is shown on screen or sent anywhere else.
cd "${0:A:h}" || exit 1
echo ""
echo "Roomcode: add your Nexconn keys"
echo "--------------------------------"
# If the keys were already pasted into .env by hand, reuse them.
envval() { [[ -f .env ]] && sed -n "s/^$1=//p" .env | tail -1 | tr -d '[:space:]'; }
APPKEY="$(envval NEXCONN_APP_KEY)"; [[ -z "$APPKEY" ]] && APPKEY="$(envval VITE_NEXCONN_APP_KEY)"
SECRET="$(envval NEXCONN_APP_SECRET)"
if [[ -n "$APPKEY" && -n "$SECRET" ]]; then
  echo "Found both keys already saved in .env. Using those."
else
  echo "Your browser will open the Nexconn console's Key Management page."
  echo "(Log in if it asks. Use your 'First application'.)"
  open "https://console.nexconn.ai/agile/apps/km"
  echo ""
  read -r "APPKEY?1) Copy the App Key, paste it here, press Enter: "
  read -rs "SECRET?2) Copy the App Secret, paste it here (it stays hidden), press Enter: "
  echo ""
fi
APPKEY="${APPKEY//[[:space:]]/}"; SECRET="${SECRET//[[:space:]]/}"
if [[ -z "$APPKEY" || -z "$SECRET" ]]; then
  echo "One of the two was empty. Nothing was saved. Double-click this file to try again."
  read -r "?Press Enter to close."; exit 1
fi

# Save to the local .env (keep any other lines that are already there).
touch .env
grep -v -E '^(VITE_NEXCONN_APP_KEY|NEXCONN_APP_KEY|NEXCONN_APP_SECRET|VITE_NEXCONN_AREA|NEXCONN_API_HOST)=' .env > .env.tmp
{
  echo "VITE_NEXCONN_APP_KEY=$APPKEY"
  echo "VITE_NEXCONN_AREA=SG"
  echo "NEXCONN_APP_KEY=$APPKEY"
  echo "NEXCONN_APP_SECRET=$SECRET"
  echo "NEXCONN_API_HOST=api.sg-light-api.com"
  cat .env.tmp
} > .env
rm -f .env.tmp
chmod 600 .env
echo "Saved on this Mac."

# Save to the Azure site's private settings, so the live site can issue chat logins.
if az staticwebapp appsettings set -n roomcode -g roomcode-rg \
    --setting-names "NEXCONN_APP_KEY=$APPKEY" "NEXCONN_APP_SECRET=$SECRET" "NEXCONN_API_HOST=api.sg-light-api.com" \
    >/dev/null 2>&1; then
  echo "Saved to the Roomcode site on Azure."
  AZ=ok
else
  echo "Could not reach Azure just now (that's fine: Claude will finish this part)."
  AZ=failed
fi
unset SECRET
date -u +"keys added %Y-%m-%d %H:%M UTC (azure: $AZ)" > KEYS_IN.txt
echo ""
echo "All done. Tell Claude: keys in"
read -r "?Press Enter to close this window."
