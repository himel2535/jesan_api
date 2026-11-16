import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes with argon2id and verifies only the right password', async () => {
    const hash = await service.hash('a-long-enough-password');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(hash).not.toContain('a-long-enough-password');
    expect(await service.verify(hash, 'a-long-enough-password')).toBe(true);
    expect(await service.verify(hash, 'another-long-password')).toBe(false);
  });

  it('gives a different hash each time (random salt)', async () => {
    expect(await service.hash('same-password-123')).not.toBe(
      await service.hash('same-password-123'),
    );
  });

  it('treats a damaged hash as a failed check instead of crashing', async () => {
    expect(await service.verify('not-a-hash', 'whatever-password')).toBe(false);
    expect(await service.verify('', 'whatever-password')).toBe(false);
  });

  it('can spend the time of a real check for an unknown user', async () => {
    await expect(service.verifyDummy('whatever-password')).resolves.toBeUndefined();
  });

  describe('password rules', () => {
    const accept = (password: string, personal = {}) => {
      service.assertAcceptable(password, personal);
    };

    it('accepts a password within the length limits', () => {
      expect(() => {
        accept('x'.repeat(PASSWORD_MIN_LENGTH));
      }).not.toThrow();
      expect(() => {
        accept('x'.repeat(PASSWORD_MAX_LENGTH));
      }).not.toThrow();
    });

    it('rejects one that is too short or too long', () => {
      expect(() => {
        accept('x'.repeat(PASSWORD_MIN_LENGTH - 1));
      }).toThrow(BadRequestException);
      expect(() => {
        accept('x'.repeat(PASSWORD_MAX_LENGTH + 1));
      }).toThrow(BadRequestException);
    });

    it('rejects the user’s own email or phone, whatever the case', () => {
      expect(() => {
        accept('Boss@Example.test', { email: 'boss@example.test' });
      }).toThrow('must not be your email');
      expect(() => {
        accept('+8801712345678', { phone: '+8801712345678' });
      }).toThrow('must not be your email');
    });

    it('does not force symbols or capitals', () => {
      expect(() => {
        accept('alllowercaseandlong');
      }).not.toThrow();
    });
  });
});
