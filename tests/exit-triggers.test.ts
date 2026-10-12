import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FlickDetector,
  desktopMayOpen,
  leftThroughTop,
  phoneIdleMayOpen,
  readingDepth,
} from '../lib/leads/exit-triggers';

test('desktop: only a pointer leaving through the top edge counts', () => {
  assert.equal(leftThroughTop({ clientY: 0, relatedTarget: null }), true);
  assert.equal(leftThroughTop({ clientY: -3, relatedTarget: null }), true);
  assert.equal(leftThroughTop({ clientY: 400, relatedTarget: null }), false); // left through the side or bottom
  assert.equal(leftThroughTop({ clientY: 0, relatedTarget: {} }), false); // moved onto another element
});

test('desktop: the visitor gets six seconds with the page first', () => {
  assert.equal(desktopMayOpen(5999), false);
  assert.equal(desktopMayOpen(6000), true);
});

test('reading depth is the bottom of the screen as a share of the page', () => {
  assert.equal(readingDepth(0, 800, 4000), 0.2);
  assert.equal(readingDepth(3200, 800, 4000), 1);
  assert.equal(readingDepth(9000, 800, 4000), 1);
  assert.equal(readingDepth(0, 800, 0), 0);
});

function scrollTo(detector: FlickDetector, samples: Array<[number, number]>) {
  let fired = false;
  for (const [y, t] of samples) fired = detector.push({ y, t, viewportHeight: 800, documentHeight: 4000 }) || fired;
  return fired;
}

test('phone: a quick flick up after reading some of the page fires', () => {
  assert.equal(scrollTo(new FlickDetector(), [[0, 0], [1200, 500], [2000, 1000], [1200, 1300], [600, 1500]]), true);
});

test('phone: a slow scroll back up does not fire', () => {
  assert.equal(scrollTo(new FlickDetector(), [[0, 0], [2000, 1000], [1800, 2000], [1500, 3000], [1200, 4000], [900, 5000]]), false);
});

test('phone: a flick before reading enough of the page does not fire', () => {
  // Deepest reading point: (400 + 800) / 4000 = 0.30, under the 0.35 floor.
  assert.equal(scrollTo(new FlickDetector(), [[0, 0], [400, 100], [0, 300]]), false);
});

test('phone: forty seconds with a quarter of the page read is the fallback', () => {
  assert.equal(phoneIdleMayOpen(39_999, 0.5), false);
  assert.equal(phoneIdleMayOpen(40_000, 0.24), false);
  assert.equal(phoneIdleMayOpen(40_000, 0.25), true);
});
