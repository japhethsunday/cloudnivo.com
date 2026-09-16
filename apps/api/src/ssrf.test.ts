import { describe, expect, it } from 'vitest';
import { isPrivateResolvedIp, resolvesToPublicAddress } from './ssrf.js';

describe('SSRF address guard', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.16.9.9',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '[::1]',
    'not-an-ip',
  ])('treats %s as private', addr => {
    expect(isPrivateResolvedIp(addr)).toBe(true);
  });

  it.each(['8.8.8.8', '198.51.100.7', '2606:4700::1111'])('treats %s as public', addr => {
    expect(isPrivateResolvedIp(addr)).toBe(false);
  });

  it('judges literal addresses without DNS', async () => {
    await expect(resolvesToPublicAddress('169.254.169.254')).resolves.toBe(false);
    await expect(resolvesToPublicAddress('[::1]')).resolves.toBe(false);
    await expect(resolvesToPublicAddress('8.8.8.8')).resolves.toBe(true);
  });

  it('fails closed when a hostname cannot be resolved', async () => {
    await expect(
      resolvesToPublicAddress('this-host-does-not-exist.invalid'),
    ).resolves.toBe(false);
  });
});
