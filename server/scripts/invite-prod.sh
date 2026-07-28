#!/usr/bin/env bash
#
# Manage the closed-alpha invite list on PRODUCTION.
#
#   npm run invite:prod -- list
#   npm run invite:prod -- add someone@example.com another@example.com
#   npm run invite:prod -- remove someone@example.com
#
# Runs inside the running API container, so it uses the production DATABASE_URL that already lives
# there. That is deliberate: the repo's environment guard refuses to point a local command at the
# production database, and no invite credential should ever sit on a laptop.
#
# There is no admin HTTP endpoint for this on purpose — an allowlist that can be edited over the
# internet is a much bigger target than one that needs SSH.

set -euo pipefail

HOST="${KAIRO_RELEASE_HOST:-era@178.105.44.3}"
SSH_KEY="${KAIRO_RELEASE_SSH_KEY:-$HOME/.ssh/id_ed25519_2}"
CONTAINER="${KAIRO_CONTAINER:-kairo-server}"

COMMAND="${1:-list}"
shift || true

case "${COMMAND}" in
  list | add | remove) ;;
  *)
    echo "Usage: npm run invite:prod -- [list | add <emails…> | remove <emails…>]" >&2
    exit 1
    ;;
esac

if [[ "${COMMAND}" != "list" && $# -eq 0 ]]; then
  echo "✗ No emails given." >&2
  exit 1
fi

EMAILS="$*"

# The node script runs in the container; emails come in through an env var rather than string
# interpolation so an address can never be read as shell or SQL.
ssh -i "${SSH_KEY}" "${HOST}" \
  "docker exec -e KAIRO_INVITE_CMD='${COMMAND}' -e KAIRO_INVITE_EMAILS='${EMAILS}' ${CONTAINER} node -e '
const { Pool } = require(\"pg\");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const command = process.env.KAIRO_INVITE_CMD;
const emails = (process.env.KAIRO_INVITE_EMAILS || \"\")
  .split(/\\s+/)
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

(async () => {
  if (command === \"list\") {
    const { rows } = await pool.query(
      \"SELECT email, note, redeemed_at FROM access_invite ORDER BY invited_at DESC\"
    );
    if (!rows.length) console.log(\"No invites yet — nobody can sign in or download.\");
    for (const row of rows) {
      const used = row.redeemed_at ? \"signed in\" : \"not yet\";
      console.log(row.email.padEnd(38) + used + (row.note ? \"  · \" + row.note : \"\"));
    }
    if (rows.length) {
      const used = rows.filter((r) => r.redeemed_at).length;
      console.log(\"\\n\" + rows.length + \" invited, \" + used + \" signed in.\");
    }
  } else if (command === \"add\") {
    let added = 0;
    for (const email of emails) {
      const r = await pool.query(
        \"INSERT INTO access_invite (email) VALUES (\$1) ON CONFLICT (email) DO NOTHING RETURNING email\",
        [email]
      );
      added += r.rowCount;
    }
    console.log(\"✓ \" + added + \" new invite(s); \" + (emails.length - added) + \" already had access.\");
  } else {
    for (const email of emails) {
      const r = await pool.query(\"DELETE FROM access_invite WHERE email = \$1 RETURNING email\", [email]);
      console.log(r.rowCount ? \"✓ removed \" + email : \"· \" + email + \" was not on the list\");
    }
    console.log(\"\\nNote: existing sessions stay valid until they expire.\");
  }
  await pool.end();
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
' 2>&1 | grep -v 'SECURITY WARNING\|sslmode\|libpq\|uselibpqcompat\|trace-warnings\|^$\|^To prepare\|^- If you\|^See https'"
