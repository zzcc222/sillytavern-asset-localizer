import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFolderName, PLUGIN_ID, PLUGIN_NAME, ASSETS_DIR } from '../src/constants.js';

test('constants: sanitizeFolderName basic behavior', () => {
    assert.equal(sanitizeFolderName('Alice'), 'Alice');
    assert.equal(sanitizeFolderName('Bob_Smith'), 'Bob_Smith');
    assert.equal(sanitizeFolderName('Card-123'), 'Card-123');
});

test('constants: sanitizeFolderName fixes ASCII 48-92 regex character range bug', () => {
    // Under the buggy regex /[<>:"/\\\\|?*\\x00-\\x1F]/g, \\x00-\\x1F was parsed as range '0' to '\'
    // which incorrectly replaced all digits 0-9 and uppercase letters C-Z with '_'
    assert.equal(sanitizeFolderName('Alice_123'), 'Alice_123');
    assert.equal(sanitizeFolderName('0123456789'), '0123456789');
    assert.equal(sanitizeFolderName('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    assert.equal(sanitizeFolderName('abcdefghijklmnopqrstuvwxyz'), 'abcdefghijklmnopqrstuvwxyz');
});

test('constants: sanitizeFolderName sanitizes illegal Windows characters', () => {
    // Windows illegal chars: < > : " / \ | ? *
    assert.equal(sanitizeFolderName('Card<1>:Part"2"'), 'Card_1__Part_2_');
    assert.equal(sanitizeFolderName('Path/To\\File|Name?*'), 'Path_To_File_Name__');
});

test('constants: sanitizeFolderName strips trailing dots and spaces correctly', () => {
    assert.equal(sanitizeFolderName('Hero.v1.0...'), 'Hero.v1.0');
    assert.equal(sanitizeFolderName('Hero.v1.0. . . '), 'Hero.v1.0');
    assert.equal(sanitizeFolderName('   SpaceCard   '), 'SpaceCard');
});

test('constants: sanitizeFolderName handles fallback on empty or dot-only inputs', () => {
    assert.equal(sanitizeFolderName(''), 'card');
    assert.equal(sanitizeFolderName('   '), 'card');
    assert.equal(sanitizeFolderName('...'), 'card');
    assert.equal(sanitizeFolderName(null), 'card');
    assert.equal(sanitizeFolderName(undefined), 'card');
    assert.equal(sanitizeFolderName(12345), 'card');
});

test('constants: sanitizeFolderName protects Windows reserved device names', () => {
    assert.equal(sanitizeFolderName('CON'), '_CON');
    assert.equal(sanitizeFolderName('prn'), '_prn');
    assert.equal(sanitizeFolderName('aux'), '_aux');
    assert.equal(sanitizeFolderName('nul'), '_nul');
    assert.equal(sanitizeFolderName('com1'), '_com1');
    assert.equal(sanitizeFolderName('LPT9'), '_LPT9');
});

test('constants: sanitizeFolderName handles brackets and parentheses safely', () => {
    assert.equal(sanitizeFolderName('Alice (v2) [HD Edition]'), 'Alice (v2) [HD Edition]');
    assert.equal(sanitizeFolderName('[V3] Hero (Uncensored)'), '[V3] Hero (Uncensored)');
});

test('constants: core constants are exported properly', () => {
    assert.equal(PLUGIN_ID, 'st-asset-localizer');
    assert.equal(PLUGIN_NAME, '图池本地化管家');
    assert.ok(typeof ASSETS_DIR === 'string');
});
