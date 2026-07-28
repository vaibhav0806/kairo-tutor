#!/usr/bin/env node
/**
 * Closed-alpha invite list.
 *
 *   npm run invite -- list
 *   npm run invite -- add a@example.com b@example.com
 *   npm run invite -- add --file emails.txt --note "batch 1"
 *   npm run invite -- remove a@example.com
 *
 * Runs against whatever DATABASE_URL the environment points at — locally that is Neon `dev`, and
 * on the Hetzner box it is Neon `production`. There is deliberately NO admin HTTP endpoint: an
 * invite list is exactly the kind of thing that should not be reachable from the internet.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { addInvites, listInvites, removeInvite } from '../src/access/service.ts';
import { pool } from '../src/db/client.ts';

const [command, ...rest] = process.argv.slice(2);

function parseArgs(args) {
  const emails = [];
  let note;
  let file;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--note') note = args[++i];
    else if (args[i] === '--file') file = args[++i];
    else emails.push(args[i]);
  }
  if (file) {
    // One email per line; blank lines and #comments ignored so a pasted export just works.
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    emails.push(...lines);
  }
  return { emails, note };
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

try {
  if (command === 'list') {
    const rows = await listInvites();
    if (rows.length === 0) {
      console.log('No invites yet. Nobody can sign in.');
    } else {
      for (const row of rows) {
        const used = row.redeemed_at ? `used ${new Date(row.redeemed_at).toISOString().slice(0, 10)}` : 'not used yet';
        console.log(`${row.email.padEnd(38)} ${used}${row.note ? `  · ${row.note}` : ''}`);
      }
      console.log(`\n${rows.length} invited, ${rows.filter((r) => r.redeemed_at).length} signed in.`);
    }
  } else if (command === 'add') {
    const { emails, note } = parseArgs(rest);
    if (emails.length === 0) fail('No emails given. Pass them as arguments or with --file.');
    else {
      const added = await addInvites(emails, note);
      console.log(`✓ ${added} new invite(s); ${emails.length - added} already had access.`);
    }
  } else if (command === 'remove') {
    const { emails } = parseArgs(rest);
    if (emails.length === 0) fail('No email given.');
    for (const email of emails) {
      const removed = await removeInvite(email);
      console.log(removed ? `✓ removed ${email}` : `· ${email} was not on the list`);
    }
    // Removing an invite blocks FUTURE sign-ins. An already-issued session token stays valid for
    // up to 30 days — delete their session rows too if the intent is to cut someone off now.
    console.log('\nNote: existing sessions stay valid until they expire.');
  } else {
    console.log('Usage: npm run invite -- [list | add <emails…> [--file f] [--note n] | remove <email>]');
  }
} finally {
  await pool.end();
}
