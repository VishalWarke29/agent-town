/** Parse dollars without floating-point rounding; one microdollar is the smallest unit. */
export function dollarsToMicroUsd(value: string): number {
  if (!/^\d{1,7}(?:\.\d{1,6})?$/.test(value.trim())) throw new Error('Use a dollar amount with up to six decimal places.');
  const [whole, fraction = ''] = value.trim().split('.');
  const result = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (result > 1_000_000_000_000n) throw new Error('This amount is above the local limit.');
  return Number(result);
}

export const editMoney = (value: number) => (value / 1_000_000).toFixed(6).replace(/\.?0+$/, '');
export const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value / 1_000_000);
