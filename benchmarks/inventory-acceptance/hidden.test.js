'use strict';
// M4.7 hidden acceptance for the inventory task (never shown to a harness). Every case follows from the task's
// visible tests and their wording; none needs knowledge beyond them.
const test = require('node:test');
const assert = require('node:assert');
const inv = require(process.env.INVENTORY_SRC);

test('three adds accumulate', () => {
  const i = inv.create();
  for (const q of [1, 2, 3]) inv.addItem(i, 'a', q, 10);
  assert.strictEqual(i.get('a').qty, 6);
});
test('zero is not a positive quantity', () => {
  assert.throws(() => inv.addItem(inv.create(), 'a', 0, 10));
});
test('a non-number quantity is refused', () => {
  assert.throws(() => inv.addItem(inv.create(), 'a', '2', 10));
});
test('a partial removal keeps the remainder', () => {
  const i = inv.create();
  inv.addItem(i, 'a', 5, 10);
  assert.strictEqual(inv.removeItem(i, 'a', 2).qty, 3);
});
test('removing an unknown sku throws', () => {
  assert.throws(() => inv.removeItem(inv.create(), 'zz', 1));
});
test('a refused over-removal leaves the state unchanged', () => {
  const i = inv.create();
  inv.addItem(i, 'a', 2, 10);
  assert.throws(() => inv.removeItem(i, 'a', 5));
  assert.strictEqual(i.get('a').qty, 2);
  assert.strictEqual(inv.totalValue(i), 20);
});
test('value after removing everything is zero', () => {
  const i = inv.create();
  inv.addItem(i, 'a', 2, 10);
  inv.removeItem(i, 'a', 2);
  assert.strictEqual(inv.totalValue(i), 0);
});
test('value of many items', () => {
  const i = inv.create();
  for (let n = 1; n <= 10; n++) inv.addItem(i, 's' + n, n, n * 3);
  assert.strictEqual(inv.totalValue(i), 3 * 385);
});
test('csv without a header and with CRLF line ends', () => {
  assert.deepStrictEqual(inv.parseCsv('a,1,2\r\nb,3,4\r\n'), [{ sku: 'a', qty: 1, price: 2 }, { sku: 'b', qty: 3, price: 4 }]);
});
test('csv with several quoted commas', () => {
  assert.deepStrictEqual(inv.parseCsv('"a,b,c",1,2\n'), [{ sku: 'a,b,c', qty: 1, price: 2 }]);
});
