import { describe, expect, it } from 'vitest';
import {
  buildInviteEmail,
  buildMagicLinkEmail,
  buildOtpEmailContent,
  buildResetEmail,
  buildSecurityEmail,
  buildVerifyEmail,
  buildWelcomeEmail,
  type BrandContext,
} from './email.js';

/**
 * Every transactional email must arrive as the branded template, not as a
 * bare line of text. The platform password reset shipped without brand
 * context and was delivered as plain text — these tests pin the shape of
 * what each builder produces so that cannot pass unnoticed again.
 */

const brand: BrandContext = {
  appUrl: 'https://cloudnivo.org',
  logoUrl: 'https://cloudnivo.org/email-logo.png',
};

const BUILT: [string, { subject: string; text: string; html?: string }][] = [
  ['verify', buildVerifyEmail('https://cloudnivo.org/verify?token=t', brand)],
  ['reset', buildResetEmail('https://cloudnivo.org/reset-password?token=t', brand)],
  ['magic link', buildMagicLinkEmail('https://cloudnivo.org/magic?token=t', brand)],
  ['otp', buildOtpEmailContent('123456', 'sign-in', brand)],
  ['security', buildSecurityEmail('A new device signed in.', brand)],
  [
    'invite',
    buildInviteEmail(
      { orgName: 'Northwind', inviter: 'ada@example.com', acceptUrl: 'https://cloudnivo.org/invites/x', role: 'admin' },
      brand,
    ),
  ],
  [
    'welcome',
    buildWelcomeEmail({ displayName: 'Ada', appUrl: brand.appUrl, logoUrl: brand.logoUrl }),
  ],
];

describe.each(BUILT)('%s email', (kind, built) => {
  it('renders an HTML document, not a bare string', () => {
    expect(built.html, `${kind} must have an HTML part`).toBeTruthy();
    expect(built.html).toMatch(/^<!DOCTYPE html>/i);
    expect(built.html).toContain('</html>');
  });

  it('carries the CloudNivo brand and logo', () => {
    expect(built.html).toContain('CloudNivo');
    expect(built.html).toContain(brand.logoUrl);
    // Never an SVG: Gmail and Outlook refuse to render one in an email, and
    // the brand slot then shows a broken-image box.
    expect(built.html).not.toMatch(/\.svg/i);
  });

  it('keeps a plain-text alternative for clients that cannot render HTML', () => {
    expect(built.text.length).toBeGreaterThan(20);
    expect(built.text).not.toContain('<');
  });

  it('has a subject that says what the mail is', () => {
    expect(built.subject.trim().length).toBeGreaterThan(4);
  });
});

describe('template content', () => {
  it('puts the real action link in both parts of the reset email', () => {
    const url = 'https://cloudnivo.org/reset-password?token=abc123';
    const built = buildResetEmail(url, brand);
    expect(built.text).toContain(url);
    expect(built.html).toContain(url);
  });

  it('never leaks a raw template placeholder', () => {
    for (const [kind, built] of BUILT) {
      expect(built.html, `${kind} html`).not.toMatch(/\{\{|\$\{|undefined|\[object Object\]/);
      expect(built.text, `${kind} text`).not.toMatch(/\{\{|\$\{|undefined|\[object Object\]/);
    }
  });
});
