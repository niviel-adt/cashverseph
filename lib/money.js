const MAX_CENTS = 100_000_000; // ₱1,000,000.00

function toCents(value, allowNegative = false) {
  const s = String(value ?? '').trim();
  const pattern = allowNegative ? /^-?\d{1,7}(?:\.\d{1,2})?$/ : /^\d{1,7}(?:\.\d{1,2})?$/;
  if (!pattern.test(s)) throw new Error('Enter a valid peso amount (up to 2 decimal places).');
  const negative = s.startsWith('-');
  const [whole, fraction = ''] = (negative ? s.slice(1) : s).split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) throw new Error('Amount must not exceed ₱1,000,000.');
  return negative ? -cents : cents;
}

function money(cents) {
  return (cents / 100).toFixed(2);
}

// "amount" is the customer's requested/base amount, not necessarily the actual wallet transfer.
function calculate(type, mode, amount, fee) {
  if (!['CASH_IN', 'CASH_OUT'].includes(type) || !['ADD', 'DEDUCT'].includes(mode)) {
    throw new Error('Invalid transaction or fee mode.');
  }
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(fee) || amount <= 0 || fee < 0) {
    throw new Error('Invalid amount or service fee.');
  }
  if (mode === 'DEDUCT' && fee >= amount) throw new Error('The fee must be less than the amount.');
  let cashCents, walletCents;
  if (type === 'CASH_IN') {
    cashCents = mode === 'ADD' ? amount + fee : amount;
    walletCents = mode === 'ADD' ? amount : amount - fee;
  } else {
    cashCents = mode === 'ADD' ? amount : amount - fee;
    walletCents = mode === 'ADD' ? amount + fee : amount;
  }
  if (cashCents > MAX_CENTS || walletCents > MAX_CENTS) {
    throw new Error('Total must not exceed ₱1,000,000.');
  }
  const floatDeltaCents = type === 'CASH_IN' ? -walletCents : walletCents;
  return { cashCents, walletCents, floatDeltaCents };
}

module.exports = { toCents, money, calculate, MAX_CENTS };
