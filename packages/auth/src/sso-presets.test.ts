import { describe, expect, it } from 'vitest';
import { SSO_PRESETS, ssoIssuerFor, ssoPreset } from './sso-presets.js';
import { tokenAuthMethodFor, type OidcDiscovery } from './oidc.js';

const discovery = (methods?: string[]): OidcDiscovery => ({
  issuer: 'https://acme.logto.app/oidc',
  authorization_endpoint: 'https://acme.logto.app/oidc/auth',
  token_endpoint: 'https://acme.logto.app/oidc/token',
  jwks_uri: 'https://acme.logto.app/oidc/jwks',
  token_endpoint_auth_methods_supported: methods,
});

describe('SSO provider presets', () => {
  it('builds the Logto issuer with the /oidc path its discovery lives under', () => {
    expect(ssoIssuerFor('logto', 'acme')).toBe('https://acme.logto.app/oidc');
    // Pasting a full endpoint is the common mistake; it still resolves.
    expect(ssoIssuerFor('logto', 'https://acme.logto.app/')).toBe('https://acme.logto.app/oidc');
  });

  it('refuses a half-filled template instead of producing a broken issuer', () => {
    expect(ssoIssuerFor('logto', '   ')).toBeNull();
    expect(ssoIssuerFor('nope', 'acme')).toBeNull();
  });

  it('returns fixed issuers without needing a tenant', () => {
    expect(ssoIssuerFor('google', '')).toBe('https://accounts.google.com');
  });

  it('keeps every preset on the scopes the ID token needs', () => {
    for (const preset of SSO_PRESETS) {
      expect(preset.scopes).toContain('openid');
      expect(preset.scopes).toContain('email');
    }
  });

  it('names Logto a confidential application type', () => {
    // A public client issues no secret, and the connection stores one.
    expect(ssoPreset('logto')?.applicationType).toBe('Traditional web');
  });
});

describe('token endpoint authentication', () => {
  it('uses Basic for Logto, which registers web apps as client_secret_basic', () => {
    expect(tokenAuthMethodFor(discovery(['client_secret_basic', 'none']))).toBe(
      'client_secret_basic',
    );
  });

  it('falls back to the form body only when Basic is not offered', () => {
    expect(tokenAuthMethodFor(discovery(['client_secret_post']))).toBe('client_secret_post');
  });

  it('treats an omitted list as Basic, per OIDC Discovery', () => {
    expect(tokenAuthMethodFor(discovery(undefined))).toBe('client_secret_basic');
    expect(tokenAuthMethodFor(discovery([]))).toBe('client_secret_basic');
  });
});
