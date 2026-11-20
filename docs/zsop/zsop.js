/*
 * Zodiac Series of Poker (zodiacseriesofpoker.com) tracker engine: the Gods of Poker engine (docs/gop/gop.js) for
 * ZSOP's site, which runs on the same software. Its events go by their own codes, at the start of each title: Z1-Z12
 * the twelve Zodiac events, H1... High Rollers, S1... satellites, 1, 2, ... side events ("Z6H4": both a Zodiac event
 * and a High Roller); the site's event numbers only group an event's flights and days, so they aren't shown.
 * Load apt/tracker.js and gop/gop.js first.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../gop/gop.js'));
  else root.ZSOPTracker = factory(root.GOPTracker);
})(typeof self !== 'undefined' ? self : this, function (GOP) {
  'use strict';
  if (!GOP || !GOP.make) throw new Error('zsop.js needs apt/tracker.js and gop/gop.js loaded first');
  return GOP.make({ site: 'https://zodiacseriesofpoker.com', org: 'zsop', labels: true });
});
