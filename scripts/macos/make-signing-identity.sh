#!/bin/bash
# One-time: makes a private code-signing certificate on this Mac so every Marion Agent build is signed
# the same way and macOS remembers its permissions (files, microphone) across updates.
set -euo pipefail
name="Marion Agent Local Signing"
if security find-certificate -c "$name" >/dev/null 2>&1; then echo "Already set up."; exit 0; fi
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
cat > "$work/cert.cnf" <<CNF
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=$name
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
CNF
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$work/cert.cnf" -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
openssl pkcs12 -export -legacy -inkey "$work/key.pem" -in "$work/cert.pem" -out "$work/id.p12" -passout pass:marion 2>/dev/null \
  || openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -out "$work/id.p12" -passout pass:marion
security import "$work/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P marion -T /usr/bin/codesign
echo "Done. The next Marion Agent update is signed with \"$name\"; allow file access once more and macOS keeps it from then on."
