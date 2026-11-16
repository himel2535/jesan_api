import { describe, expect, it } from 'vitest';
import { normalizeEmail, normalizePhone, parseLoginIdentifier } from './identifier';

describe('normalizePhone', () => {
  it.each([
    ['01712345678', '+8801712345678'],
    ['8801712345678', '+8801712345678'],
    ['+8801712345678', '+8801712345678'],
    ['+880 1712-345678', '+8801712345678'],
    ['(0171) 234 5678', '+8801712345678'],
    ['+14155552671', '+14155552671'],
  ])('turns %s into %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(['', 'abc', '12', '0171234567', '+0123456789', '017123456789012345', 'user@example.com'])(
    'rejects %j',
    (input) => {
      expect(normalizePhone(input)).toBeNull();
    },
  );
});

describe('parseLoginIdentifier', () => {
  it('treats anything with an @ as an email, lowercased and trimmed', () => {
    expect(parseLoginIdentifier('  Boss@Example.COM ')).toEqual({ email: 'boss@example.com' });
    expect(normalizeEmail('A@B.test')).toBe('a@b.test');
  });

  it('treats a phone-like value as a phone', () => {
    expect(parseLoginIdentifier('01712345678')).toEqual({ phone: '+8801712345678' });
  });

  it('gives null for something that is neither', () => {
    expect(parseLoginIdentifier('hello')).toBeNull();
  });
});
