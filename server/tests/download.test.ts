import { describe, expect, it, afterAll } from 'vitest';
import { buildApp } from '../src/app';
import { pool } from '../src/db/client';
import { issueDownloadToken, looksLikeEmail, verifyDownloadToken } from '../src/download/service';

const app = await buildApp();
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('download tokens', () => {
  it('round-trips the email it was issued for', () => {
    const token = issueDownloadToken('Prasad@Example.com');
    expect(verifyDownloadToken(token)).toBe('prasad@example.com');
  });

  it('rejects a tampered token', () => {
    const token = issueDownloadToken('a@b.com');
    const [expiry, email] = token.split('.');
    // Swapping in another email must not verify — otherwise anyone could mint their own link.
    const forged = `${expiry}.${Buffer.from('someone@else.com').toString('base64url')}.${token.split('.')[2]}`;
    expect(verifyDownloadToken(forged)).toBeNull();
    expect(verifyDownloadToken(`${expiry}.${email}.not-a-signature`)).toBeNull();
    expect(verifyDownloadToken('garbage')).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = issueDownloadToken('a@b.com', Date.now() - 60 * 60 * 1000);
    expect(verifyDownloadToken(token)).toBeNull();
  });

  it('screens obvious junk before hitting the invite list', () => {
    expect(looksLikeEmail('a@b.com')).toBe(true);
    expect(looksLikeEmail('no-at-sign')).toBe(false);
    expect(looksLikeEmail('a@b')).toBe(false);
    expect(looksLikeEmail('')).toBe(false);
  });
});

describe('download routes', () => {
  it('refuses a malformed email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/download/request',
      payload: { email: 'nope' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('tells an uninvited email it is not in, without handing out a link', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/download/request',
      payload: { email: `uninvited-${Date.now()}@example.com` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ invited: false });
    expect(res.json().url).toBeUndefined();
  });

  it('refuses the file itself without a valid token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/download/dmg?token=forged.token.here' });
    expect(res.statusCode).toBe(403);
  });
});
