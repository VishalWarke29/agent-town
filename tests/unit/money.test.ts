import { describe, expect, it } from 'vitest';
import { dollarsToMicroUsd, editMoney } from '../../apps/web/src/money';

describe('budget form currency conversion', () => {
  it('retains exact microdollar values without binary floating-point rounding', () => {
    expect(dollarsToMicroUsd('0.000001')).toBe(1);
    expect(dollarsToMicroUsd('0.100001')).toBe(100001);
    expect(dollarsToMicroUsd('12.345678')).toBe(12345678);
    expect(dollarsToMicroUsd('1000000')).toBe(1_000_000_000_000);
    for (const value of [0, 1, 100001, 12345678, 1_000_000_000_000]) expect(dollarsToMicroUsd(editMoney(value))).toBe(value);
  });
  it('rejects missing, negative, ambiguous, too-precise, or out-of-range amounts', () => {
    for (const value of ['', ' ', '-1', 'NaN', 'Infinity', '1e3', '1,000', '0.0000001', '1000000.000001']) expect(() => dollarsToMicroUsd(value)).toThrow();
  });
});
