/**
 * Money is a whole number of kobo (1/100 of a naira), carried as a branded
 * number so it cannot be mixed up with a plain one.
 *
 * The bug this is aimed at is real: a seller was once charged ₦4,120 where the
 * correct fee was ₦1,030, because a percentage was read from the wrong place.
 * A brand does not catch a wrong rate — nothing in a type system does — but it
 * does catch the whole family of errors where naira are added to kobo, or a
 * float sneaks into an amount and rounds where nobody is looking.
 */

declare const brand: unique symbol;

export type Kobo = number & { readonly [brand]: 'Kobo' };

export function kobo(n: number): Kobo {
  if (!Number.isInteger(n)) {
    throw new TypeError(`amounts are whole kobo, got ${n}`);
  }
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`amount is beyond safe integer range: ${n}`);
  }
  // Negative zero is a real, distinct value: Object.is(-0, 0) is false. It
  // arrives whenever an empty balance has its sign flipped, and it compares
  // unequal to zero in a strict assertion while printing as "0" in every log
  // and error message you would look at. Collapse it here, once.
  return (n === 0 ? 0 : n) as Kobo;
}

/** ₦96.50 → 9650 kobo. Only for reading human input; never for arithmetic. */
export function naira(amount: number): Kobo {
  return kobo(Math.round(amount * 100));
}

export function addKobo(a: Kobo, b: Kobo): Kobo {
  return kobo(a + b);
}

export function negate(a: Kobo): Kobo {
  return kobo(-a);
}

/** 965000 → "₦9,650.00". Display only. */
export function format(amount: Kobo): string {
  const negative = amount < 0;
  const whole = Math.abs(amount);
  const naira = Math.trunc(whole / 100);
  const rest = String(whole % 100).padStart(2, '0');
  return `${negative ? '-' : ''}₦${naira.toLocaleString('en-NG')}.${rest}`;
}
