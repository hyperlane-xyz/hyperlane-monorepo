import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import { encodeFunctionData, getAddress, parseAbi } from 'viem';

import {
  DEFAULT_SAFE_DEPLOYMENT_VERSIONS,
  asHex,
  createSafeTransaction,
  createSafeTransactionData,
  deleteAllPendingSafeTxs,
  deleteSafeTx,
  decodeMultiSendData,
  getSafeTx,
  getKnownMultiSendAddresses,
  getOwnerChanges,
  hasSafeServiceTransactionPayload,
  isLegacySafeApi,
  normalizeSafeServiceUrl,
  parseSafeTx,
  proposeSafeTransaction,
  resolveSafeSigner,
  safeApiKeyRequired,
} from './gnosisSafe.js';

describe('gnosisSafe utils', () => {
  const safeInterface = new ethers.utils.Interface([
    'function swapOwner(address prevOwner,address oldOwner,address newOwner)',
    'function addOwnerWithThreshold(address owner,uint256 _threshold)',
    'function changeThreshold(uint256 _threshold)',
  ]);

  describe(safeApiKeyRequired.name, () => {
    it('returns true for safe.global urls', () => {
      expect(
        safeApiKeyRequired('https://safe-transaction-mainnet.safe.global/api'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('http://safe-transaction-mainnet.safe.global/api'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'HTTP://SAFE-TRANSACTION-MAINNET.SAFE.GLOBAL:80/API',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'http://safe-transaction-mainnet.safe.global:80/api',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.safe.global:443/api',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.safe.global:80/api',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.safe.global/api?email=user@hyperlane.xyz#user@hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.safe.global/api?email=user%40hyperlane.xyz#user%40hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.safe.global/api?email=user%25252540hyperlane.xyz#user%25252540hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.safe.global/api?note=user%5Chyperlane.xyz#note%5Chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.safe.global/api?note=user%255Chyperlane.xyz#note%255Chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.safe.global/api?note=user%25255Chyperlane.xyz#note%25255Chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe.global/api?note=user%255Chyperlane.xyz#note%255Chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe.global/api?note=user%25255Chyperlane.xyz#note%25255Chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe.global/api?note=user%255chyperlane.xyz#note%255chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe.global/api?note=user%25255chyperlane.xyz#note%25255chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'http://safe-transaction-mainnet.safe.global/api?email=user@hyperlane.xyz#user@hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'http://safe-transaction-mainnet.safe.global/api?email=user%25252540hyperlane.xyz#user%25252540hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'http://safe-transaction-mainnet.safe.global/api?note=user%5Chyperlane.xyz#note%5Chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.safe.global/path@foo/api',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.safe.global/path%40foo/api',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.safe.global/path%5Cfoo/api',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.safe.global/path%255Cfoo/api',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.safe.global/path%25255Cfoo/api',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.safe.global/path%255cfoo/api',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.safe.global/path%25255cfoo/api',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.safe.global/path%252540foo/api',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.safe.global/path%25252540foo/api',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.safe.global/path%2Esegment/api',
        ),
      ).to.equal(true);
      expect(safeApiKeyRequired('https://safe.global/路径/api')).to.equal(true);
      expect(
        safeApiKeyRequired(
          'http://safe-transaction-mainnet.safe.global/path@foo/api',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'HTTPS://SAFE-TRANSACTION-MAINNET.SAFE.GLOBAL:443/API',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https:////safe-transaction-mainnet.safe.global/api',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('http:///safe-transaction-mainnet.safe.global/api'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('HTTP://SAFE-TRANSACTION-MAINNET.SAFE.GLOBAL/API'),
      ).to.equal(true);
    });

    it('returns true for 5afe.dev urls', () => {
      expect(
        safeApiKeyRequired('https://safe-transaction-mainnet.5afe.dev/api'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev/path%5Cfoo/api',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev/path%255Cfoo/api',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev/path%255cfoo/api',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev/path%25255Cfoo/api',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev/path%25255cfoo/api',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev/path%2Esegment/api',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('https://safe-transaction-mainnet.5afe.dev/путь'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('safe-transaction-mainnet.5afe.dev/path%25255cfoo'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.5afe.dev?email=user%25252540hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.5afe.dev?note=user%5Chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.5afe.dev?note=user%255chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.5afe.dev?note=user%25255chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.5afe.dev#note%255chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.5afe.dev#note%25255chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.5afe.dev/path%252540foo',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('//safe-transaction-mainnet.5afe.dev/path%5Cfoo'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.5afe.dev/path%25255cfoo',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.5afe.dev#note%25255chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.5afe.dev/api?note=user%25255chyperlane.xyz#note%25255chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev%252540evil.com/api',
        ),
      ).to.equal(false);
    });

    it('returns false for custom tx service urls', () => {
      expect(
        safeApiKeyRequired('https://transaction.safe.somechain.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('//transaction.safe.somechain.com/api'),
      ).to.equal(false);
    });

    it('returns false for non-http schemes even on safe hosts', () => {
      expect(safeApiKeyRequired('ftp://safe.global/api')).to.equal(false);
      expect(
        safeApiKeyRequired('ws://safe-transaction-mainnet.5afe.dev'),
      ).to.equal(false);
      expect(safeApiKeyRequired('https:/safe.global/api')).to.equal(false);
      expect(safeApiKeyRequired('http:/safe.global/api')).to.equal(false);
      expect(safeApiKeyRequired('https:/@safe.global/api')).to.equal(false);
      expect(safeApiKeyRequired('http:/@safe.global/api')).to.equal(false);
      expect(safeApiKeyRequired('https:\\safe.global\\api')).to.equal(false);
      expect(
        safeApiKeyRequired('http:\\safe-transaction-mainnet.5afe.dev\\api'),
      ).to.equal(false);
      expect(safeApiKeyRequired('https:\\safe.global/api')).to.equal(false);
      expect(
        safeApiKeyRequired('http:\\safe-transaction-mainnet.5afe.dev/api'),
      ).to.equal(false);
      expect(safeApiKeyRequired('https:\\\\safe.global/api')).to.equal(false);
      expect(
        safeApiKeyRequired('http:\\\\safe-transaction-mainnet.5afe.dev/api'),
      ).to.equal(false);
      expect(safeApiKeyRequired('https:\\//safe.global/api')).to.equal(false);
      expect(
        safeApiKeyRequired('http:\\//safe-transaction-mainnet.5afe.dev/api'),
      ).to.equal(false);
      expect(safeApiKeyRequired('https://safe.global\\api')).to.equal(false);
      expect(
        safeApiKeyRequired('http://safe-transaction-mainnet.5afe.dev\\api'),
      ).to.equal(false);
      expect(safeApiKeyRequired('https://safe.global\\?foo=bar')).to.equal(
        false,
      );
      expect(
        safeApiKeyRequired('https:/safe-transaction-mainnet.5afe.dev'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('http:/safe-transaction-mainnet.5afe.dev'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('https:/@safe-transaction-mainnet.5afe.dev'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('http:/@safe-transaction-mainnet.5afe.dev'),
      ).to.equal(false);
      expect(safeApiKeyRequired('mailto:safe.global')).to.equal(false);
      expect(safeApiKeyRequired('data:text/plain,safe.global')).to.equal(false);
      expect(safeApiKeyRequired('foo:/safe.global')).to.equal(false);
      expect(
        safeApiKeyRequired('urn:safe-transaction-mainnet.safe.global'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('blob:https://safe-transaction-mainnet.safe.global'),
      ).to.equal(false);
    });

    it('handles uppercase hosts and safe subdomains', () => {
      expect(
        safeApiKeyRequired('HTTPS://SAFE-TRANSACTION-MAINNET.SAFE.GLOBAL/API'),
      ).to.equal(true);
    });

    it('does not match safe domain strings outside hostname', () => {
      expect(
        safeApiKeyRequired('https://example.com/path/safe.global/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          '//example.com/path/safe.global/api?host=safe.global',
        ),
      ).to.equal(false);
    });

    it('supports host-only service URLs without protocol', () => {
      expect(
        safeApiKeyRequired('safe-transaction-mainnet.safe.global'),
      ).to.equal(true);
      expect(safeApiKeyRequired('safe-transaction-mainnet.5afe.dev')).to.equal(
        true,
      );
      expect(
        safeApiKeyRequired('  safe-transaction-mainnet.safe.global/api  '),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('safe-transaction-mainnet.safe.global/path@foo'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('safe-transaction-mainnet.safe.global/path%40foo'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'SAFE-TRANSACTION-MAINNET.SAFE.GLOBAL/PATH%40FOO?email=user%40hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('safe-transaction-mainnet.safe.global:443/api'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('safe-transaction-mainnet.safe.global:80/api'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.safe.global?email=user@hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.safe.global?email=user%40hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.safe.global?email=user%2540hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.safe.global?email=user%252540hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.safe.global?email=user%25252540hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.safe.global?note=user%5Chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.safe.global?note=user%255Chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.safe.global?note=user%25255Chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.safe.global#user@hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.safe.global#user%40hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.safe.global#user%252540hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.safe.global#user%25252540hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.safe.global#note%5Chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.safe.global#note%255Chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.safe.global#note%25255Chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(safeApiKeyRequired('safe.global#note%255Chyperlane.xyz')).to.equal(
        true,
      );
      expect(
        safeApiKeyRequired('safe.global#note%25255Chyperlane.xyz'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'SAFE-TRANSACTION-MAINNET.SAFE.GLOBAL?email=user%40hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.safe.global:443?email=user@hyperlane.xyz#user@hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.safe.global:443?email=user%40hyperlane.xyz#user%40hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'SAFE-TRANSACTION-MAINNET.SAFE.GLOBAL:8443?email=user%40hyperlane.xyz#user%40hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('SAFE-TRANSACTION-MAINNET.SAFE.GLOBAL:443/API'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('safe-transaction-mainnet.5afe.dev./api'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('//safe-transaction-mainnet.safe.global/api'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('  //safe-transaction-mainnet.safe.global/api  '),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('//safe-transaction-mainnet.safe.global/path@foo'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('//safe-transaction-mainnet.safe.global/path%40foo'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('//safe-transaction-mainnet.safe.global/path%5Cfoo'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.safe.global/path%252540foo',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.safe.global/path%255Cfoo',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.safe.global/path%25255Cfoo',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.safe.global/path%25255cfoo',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.safe.global/path%25252540foo',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//SAFE-TRANSACTION-MAINNET.SAFE.GLOBAL/PATH%40FOO?email=user%40hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.safe.global/api?label=@safe',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.safe.global/api?email=user%40hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.safe.global/api?email=user%2540hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.safe.global/api?email=user%252540hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.safe.global/api?email=user%25252540hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.safe.global/api?note=user%5Chyperlane.xyz#note%5Chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.safe.global/api?note=user%255Chyperlane.xyz#note%255Chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.safe.global/api?note=user%25255Chyperlane.xyz#note%25255Chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.safe.global/api?note=user%255chyperlane.xyz#note%255chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.safe.global/api?note=user%25255chyperlane.xyz#note%25255chyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.safe.global/api?foo=bar#fragment',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('//safe-transaction-mainnet.safe.global?foo=bar'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.safe.global/#user@hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.safe.global?email=user@hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.safe.global#user@hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.safe.global#user%252540hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.safe.global#user%25252540hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//SAFE-TRANSACTION-MAINNET.SAFE.GLOBAL?email=user@hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          '//SAFE-TRANSACTION-MAINNET.SAFE.GLOBAL?email=user%40hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('https://safe-transaction-mainnet.safe.global:8443'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https:////safe-transaction-mainnet.safe.global/api?email=user%25252540hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'http:///safe-transaction-mainnet.safe.global#user%25252540hyperlane.xyz',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('//safe-transaction-mainnet.safe.global:8443/api'),
      ).to.equal(true);
      expect(safeApiKeyRequired('//safe.global')).to.equal(true);
      expect(safeApiKeyRequired('//safe.global:443/api')).to.equal(true);
      expect(safeApiKeyRequired('//SAFE.GLOBAL:443/API')).to.equal(true);
      expect(safeApiKeyRequired('//safe.global./api')).to.equal(true);
    });

    it('requires safe domains to match on label boundaries', () => {
      expect(safeApiKeyRequired('https://notsafe.global/api')).to.equal(false);
      expect(safeApiKeyRequired('https://safe.global/api')).to.equal(true);
      expect(safeApiKeyRequired('https://user:pass@safe.global/api')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('http://user:pass@safe.global/api')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('https://@safe.global/api')).to.equal(false);
      expect(safeApiKeyRequired('http://@safe.global/api')).to.equal(false);
      expect(safeApiKeyRequired('https://:@safe.global/api')).to.equal(false);
      expect(safeApiKeyRequired('http://:@safe.global/api')).to.equal(false);
      expect(safeApiKeyRequired('https://safe.global.evil.com/api')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('https://safe.global@evil.com/api')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('http:///safe.global@evil.com/api')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('https:////safe.global@evil.com/api')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('https:////@safe.global/api')).to.equal(false);
      expect(safeApiKeyRequired('http:////@safe.global/api')).to.equal(false);
      expect(
        safeApiKeyRequired('http:///safe.global%2540evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('https:////safe.global%252540evil.com/api'),
      ).to.equal(false);
      expect(safeApiKeyRequired('//safe.global@evil.com/api')).to.equal(false);
      expect(safeApiKeyRequired('//safe.global@evil.com')).to.equal(false);
      expect(safeApiKeyRequired('//safe.global@evil.com?foo=bar')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('//safe.global@evil.com#frag')).to.equal(false);
      expect(safeApiKeyRequired('https://safe.global%40evil.com/api')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('http://safe.global%40evil.com/api')).to.equal(
        false,
      );
      expect(
        safeApiKeyRequired('https://safe.global%2540evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('https://safe.global%5C@evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('https://safe.global%255C@evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('https://safe.global%25255C@evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('https://safe.global%255c%40evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('https://safe.global%25255c%40evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('https://safe.global%255C%40evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('https://safe.global%25255C%40evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('https://safe.global%255c%2540evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('https://safe.global%255C%2540evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('https://safe.global%255c%252540evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('https://safe.global%255C%252540evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('https://safe.global%255c%25252540evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('https://safe.global%255C%25252540evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('https://safe.global%255c%2525252540evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('https://safe.global%255C%2525252540evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('https://safe.global%255c@evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('https://safe.global%25255c@evil.com/api'),
      ).to.equal(false);
      expect(safeApiKeyRequired('//safe.global%5C@evil.com/api')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('//safe.global%255C@evil.com/api')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('//safe.global%25255C@evil.com/api')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('//safe.global%255c%40evil.com/api')).to.equal(
        false,
      );
      expect(
        safeApiKeyRequired('//safe.global%25255c%40evil.com/api'),
      ).to.equal(false);
      expect(safeApiKeyRequired('//safe.global%255C%40evil.com/api')).to.equal(
        false,
      );
      expect(
        safeApiKeyRequired('//safe.global%25255C%40evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('//safe.global%255c%2540evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('//safe.global%255C%2540evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('//safe.global%255c%252540evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('//safe.global%255C%252540evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('//safe.global%255c%25252540evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('//safe.global%255C%25252540evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('//safe.global%255c%2525252540evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('//safe.global%255C%2525252540evil.com/api'),
      ).to.equal(false);
      expect(safeApiKeyRequired('//safe.global%255c@evil.com/api')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('//safe.global%25255c@evil.com/api')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('safe.global%5C@evil.com')).to.equal(false);
      expect(safeApiKeyRequired('safe.global%255C@evil.com')).to.equal(false);
      expect(safeApiKeyRequired('safe.global%25255C@evil.com')).to.equal(false);
      expect(safeApiKeyRequired('safe.global%25255c%40evil.com')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('safe.global%255C%40evil.com')).to.equal(false);
      expect(safeApiKeyRequired('safe.global%25255C%40evil.com')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('safe.global%255c%2540evil.com')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('safe.global%255C%2540evil.com')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('safe.global%255c%252540evil.com')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('safe.global%255C%252540evil.com')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('safe.global%255c%25252540evil.com')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('safe.global%255C%25252540evil.com')).to.equal(
        false,
      );
      expect(
        safeApiKeyRequired('safe.global%255c%2525252540evil.com'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('safe.global%255C%2525252540evil.com'),
      ).to.equal(false);
      expect(safeApiKeyRequired('safe.global%255c@evil.com')).to.equal(false);
      expect(safeApiKeyRequired('safe.global%25255c@evil.com')).to.equal(false);
      expect(
        safeApiKeyRequired('http://safe.global%252540evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev%5C@evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev%255c%40evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev%25255c%40evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev%255C%40evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev%25255C%40evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev%255c%2540evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev%255C%2540evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev%255c%252540evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev%255C%252540evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev%255c%25252540evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev%255C%25252540evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev%255c%2525252540evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev%255C%2525252540evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev%255c@evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev%25255c@evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'https:////safe-transaction-mainnet.5afe.dev%5C@evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.5afe.dev%255c%40evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.5afe.dev%25255c%40evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.5afe.dev%255C%40evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.5afe.dev%25255C%40evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.5afe.dev%255c%2540evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.5afe.dev%255C%2540evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.5afe.dev%255c%252540evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.5afe.dev%255C%252540evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.5afe.dev%255c%25252540evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.5afe.dev%255C%25252540evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.5afe.dev%255c%2525252540evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.5afe.dev%255C%2525252540evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.5afe.dev%255c@evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          '//safe-transaction-mainnet.5afe.dev%25255c@evil.com/api',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('safe-transaction-mainnet.5afe.dev%255c%40evil.com'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.5afe.dev%25255c%40evil.com',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('safe-transaction-mainnet.5afe.dev%255C%40evil.com'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.5afe.dev%25255C%40evil.com',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.5afe.dev%255c%2540evil.com',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.5afe.dev%255C%2540evil.com',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.5afe.dev%255c%252540evil.com',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.5afe.dev%255C%252540evil.com',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.5afe.dev%255c%25252540evil.com',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.5afe.dev%255C%25252540evil.com',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.5afe.dev%255c%2525252540evil.com',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.5afe.dev%255C%2525252540evil.com',
        ),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('safe-transaction-mainnet.5afe.dev%255c@evil.com'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('safe-transaction-mainnet.5afe.dev%25255c@evil.com'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('https://safe.global%25252540evil.com/api'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('http://safe.global%25252540evil.com/api'),
      ).to.equal(false);
      expect(safeApiKeyRequired('//safe.global%40evil.com/api')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('//safe.global%40evil.com:443/api')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('//safe.global%40evil.com')).to.equal(false);
      expect(safeApiKeyRequired('//safe.global%2540evil.com')).to.equal(false);
      expect(safeApiKeyRequired('//safe.global%2540evil.com:443/api')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('//safe.global%252540evil.com')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('safe.global%40evil.com')).to.equal(false);
      expect(safeApiKeyRequired('safe.global%40evil.com:443/api')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('safe.global%2540evil.com')).to.equal(false);
      expect(safeApiKeyRequired('safe.global%252540evil.com')).to.equal(false);
      expect(safeApiKeyRequired('https://safe.global./api')).to.equal(true);
      expect(safeApiKeyRequired('https://not5afe.dev/api')).to.equal(false);
      expect(
        safeApiKeyRequired('https://safe-transaction.5afe.dev/api'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('https://safe-transaction.5afe.dev./api'),
      ).to.equal(true);
    });

    it('does not match hostless strings containing safe domains', () => {
      expect(safeApiKeyRequired('example.com/path/safe.global/api')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('not a url safe.global')).to.equal(false);
      expect(safeApiKeyRequired('safe.global@evil.com')).to.equal(false);
      expect(safeApiKeyRequired('safe.global@evil.com:443/api')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('safe.global@evil.com?foo=bar')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('safe.global@evil.com#frag')).to.equal(false);
      expect(safeApiKeyRequired('')).to.equal(false);
      expect(safeApiKeyRequired('/safe.global/api')).to.equal(false);
      expect(safeApiKeyRequired('  /safe.global/api?foo=bar  ')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('///safe.global/api')).to.equal(false);
      expect(safeApiKeyRequired('//')).to.equal(false);
      expect(safeApiKeyRequired('//?foo=bar')).to.equal(false);
      expect(safeApiKeyRequired('//safe.global:abc')).to.equal(false);
      expect(safeApiKeyRequired('//safe.global:99999')).to.equal(false);
      expect(safeApiKeyRequired('//safe.global:')).to.equal(false);
      expect(safeApiKeyRequired('//safe.global:/api')).to.equal(false);
      expect(safeApiKeyRequired('//safe.global:/#frag')).to.equal(false);
      expect(safeApiKeyRequired('//safe.global:#frag')).to.equal(false);
      expect(safeApiKeyRequired('safe.global\\evil.com')).to.equal(false);
      expect(safeApiKeyRequired('//safe.global\\evil.com')).to.equal(false);
      expect(
        safeApiKeyRequired('safe-transaction-mainnet.5afe.dev\\foo'),
      ).to.equal(false);
      expect(
        safeApiKeyRequired('//safe-transaction-mainnet.5afe.dev\\foo'),
      ).to.equal(false);
      expect(safeApiKeyRequired('https:////\\safe.global/api')).to.equal(false);
      expect(
        safeApiKeyRequired('http:////\\safe-transaction-mainnet.5afe.dev/api'),
      ).to.equal(false);
      expect(safeApiKeyRequired('//:pass@safe.global/api')).to.equal(false);
      expect(safeApiKeyRequired('//@safe.global/api')).to.equal(false);
      expect(safeApiKeyRequired('//user:pass@safe.global/api')).to.equal(false);
      expect(safeApiKeyRequired('//user@safe.global/api')).to.equal(false);
      expect(safeApiKeyRequired('//user:@safe.global/api')).to.equal(false);
      expect(safeApiKeyRequired('//user:pass@safe.global:443/api')).to.equal(
        false,
      );
      expect(safeApiKeyRequired('//user:pass@/api')).to.equal(false);
      expect(safeApiKeyRequired('safe.global:')).to.equal(false);
      expect(
        safeApiKeyRequired('///safe-transaction-mainnet.safe.global/api'),
      ).to.equal(false);
    });

    it('returns false for non-string url inputs', () => {
      expect(safeApiKeyRequired(123)).to.equal(false);
      expect(safeApiKeyRequired(null)).to.equal(false);

      const unstringifiableUrl = {
        [Symbol.toPrimitive]: () => {
          throw new Error('boom');
        },
      };
      expect(safeApiKeyRequired(unstringifiableUrl)).to.equal(false);
    });

    it('rejects percent-encoded authorities', () => {
      const encodedDots = ['%2E', '%2e', '%252E', '%252e'];

      for (const encodedDot of encodedDots) {
        const authorities = [
          `safe${encodedDot}global`,
          `safe-transaction-mainnet${encodedDot}5afe.dev`,
        ];

        for (const authority of authorities) {
          expect(safeApiKeyRequired(`https://${authority}/api`)).to.equal(
            false,
          );
          expect(safeApiKeyRequired(`//${authority}/api`)).to.equal(false);
          expect(safeApiKeyRequired(authority)).to.equal(false);
          expect(safeApiKeyRequired(`https://${authority}:443/api`)).to.equal(
            false,
          );
          expect(safeApiKeyRequired(`//${authority}:443/api`)).to.equal(false);
          expect(safeApiKeyRequired(`${authority}:443`)).to.equal(false);
        }
      }
    });

    it('rejects non-ascii authorities', () => {
      const unicodeDotAuthorities = [
        'safe。global',
        'safe．global',
        'safe｡global',
        'safe-transaction-mainnet。5afe.dev',
      ];

      for (const authority of unicodeDotAuthorities) {
        expect(safeApiKeyRequired(`https://${authority}/api`)).to.equal(false);
        expect(safeApiKeyRequired(`//${authority}/api`)).to.equal(false);
        expect(safeApiKeyRequired(authority)).to.equal(false);
        expect(safeApiKeyRequired(`https://${authority}:443/api`)).to.equal(
          false,
        );
        expect(safeApiKeyRequired(`//${authority}:443/api`)).to.equal(false);
        expect(safeApiKeyRequired(`${authority}:443`)).to.equal(false);
      }
    });

    it('rejects control or whitespace characters in authorities', () => {
      const controlAuthorities = [
        'safe.global\t',
        'safe.global\n',
        'safe.global\r',
        'safe.\tglobal',
        'safe.\nglobal',
        'safe.global ',
        'safe-transaction-mainnet.5afe.dev\t',
      ];

      for (const authority of controlAuthorities) {
        expect(safeApiKeyRequired(`https://${authority}/api`)).to.equal(false);
        expect(safeApiKeyRequired(`//${authority}/api`)).to.equal(false);
        expect(safeApiKeyRequired(`${authority}:443`)).to.equal(false);
      }
    });

    it('accepts percent-encoded data outside the authority', () => {
      expect(
        safeApiKeyRequired('https://safe.global/path%2Esegment/api'),
      ).to.equal(true);
      expect(safeApiKeyRequired('//safe.global/path%2Esegment')).to.equal(true);
      expect(safeApiKeyRequired('safe.global/path%2Esegment')).to.equal(true);
      expect(
        safeApiKeyRequired(
          'https://safe-transaction-mainnet.5afe.dev/path%2Esegment/api',
        ),
      ).to.equal(true);
      expect(
        safeApiKeyRequired(
          'safe-transaction-mainnet.5afe.dev/path%2Esegment?next=%2Ffoo%2Ebar',
        ),
      ).to.equal(true);
    });

    it('accepts unicode path data outside the authority', () => {
      expect(safeApiKeyRequired('https://safe.global/路径/api')).to.equal(true);
      expect(safeApiKeyRequired('//safe.global/路径')).to.equal(true);
      expect(safeApiKeyRequired('safe.global/路径')).to.equal(true);
      expect(
        safeApiKeyRequired('https://safe-transaction-mainnet.5afe.dev/путь'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('//safe-transaction-mainnet.5afe.dev/путь'),
      ).to.equal(true);
      expect(
        safeApiKeyRequired('safe-transaction-mainnet.5afe.dev/путь'),
      ).to.equal(true);
    });

    it('rejects encoded-backslash userinfo spoof patterns at deeper repeated-%25 depths', () => {
      const safeHosts = ['safe.global', 'safe-transaction-mainnet.5afe.dev'];
      const encodedBackslashes = ['%255c', '%255C'];

      for (const host of safeHosts) {
        for (const encodedBackslash of encodedBackslashes) {
          for (let depth = 5; depth <= 8; depth += 1) {
            const encodedAt = `%${'25'.repeat(depth)}40`;
            const authority = `${host}${encodedBackslash}${encodedAt}evil.com`;

            expect(safeApiKeyRequired(`https://${authority}/api`)).to.equal(
              false,
            );
            expect(safeApiKeyRequired(`//${authority}/api`)).to.equal(false);
            expect(safeApiKeyRequired(authority)).to.equal(false);
          }
        }
      }
    });

    it('rejects userinfo spoof patterns at deeper repeated-%25 depths', () => {
      const safeHosts = ['safe.global', 'safe-transaction-mainnet.5afe.dev'];

      for (const host of safeHosts) {
        for (let depth = 4; depth <= 8; depth += 1) {
          const encodedAt = `%${'25'.repeat(depth)}40`;
          const authority = `${host}${encodedAt}evil.com`;

          expect(safeApiKeyRequired(`https://${authority}/api`)).to.equal(
            false,
          );
          expect(safeApiKeyRequired(`//${authority}/api`)).to.equal(false);
          expect(safeApiKeyRequired(authority)).to.equal(false);
        }
      }
    });
  });

  describe(normalizeSafeServiceUrl.name, () => {
    it('appends /api when missing', () => {
      expect(
        normalizeSafeServiceUrl('https://safe.global/tx-service/eth'),
      ).to.equal('https://safe.global/tx-service/eth/api');
      expect(normalizeSafeServiceUrl('https://safe.global/path@foo')).to.equal(
        'https://safe.global/path@foo/api',
      );
      expect(
        normalizeSafeServiceUrl('https://safe.global/path%40foo'),
      ).to.equal('https://safe.global/path%40foo/api');
      expect(
        normalizeSafeServiceUrl('https://safe.global/path%5Cfoo'),
      ).to.equal('https://safe.global/path%5Cfoo/api');
      expect(
        normalizeSafeServiceUrl('https://safe.global/path%255Cfoo'),
      ).to.equal('https://safe.global/path%255Cfoo/api');
      expect(
        normalizeSafeServiceUrl('https://safe.global/path%25255Cfoo'),
      ).to.equal('https://safe.global/path%25255Cfoo/api');
      expect(
        normalizeSafeServiceUrl('https://safe.global/path%255cfoo'),
      ).to.equal('https://safe.global/path%255cfoo/api');
      expect(
        normalizeSafeServiceUrl('https://safe.global/path%25255cfoo'),
      ).to.equal('https://safe.global/path%25255cfoo/api');
      expect(
        normalizeSafeServiceUrl('https://safe.global/path%252540foo'),
      ).to.equal('https://safe.global/path%252540foo/api');
      expect(
        normalizeSafeServiceUrl('https://safe.global/path%25252540foo'),
      ).to.equal('https://safe.global/path%25252540foo/api');
      expect(
        normalizeSafeServiceUrl('https://safe.global/path%2Esegment'),
      ).to.equal('https://safe.global/path%2Esegment/api');
      expect(normalizeSafeServiceUrl('http://safe.global/path@foo')).to.equal(
        'http://safe.global/path@foo/api',
      );
      expect(normalizeSafeServiceUrl('http://safe.global/path%40foo')).to.equal(
        'http://safe.global/path%40foo/api',
      );
      expect(
        normalizeSafeServiceUrl(
          'https://safe-transaction-mainnet.5afe.dev/path%2Esegment',
        ),
      ).to.equal(
        'https://safe-transaction-mainnet.5afe.dev/path%2Esegment/api',
      );
      expect(normalizeSafeServiceUrl('https://safe.global/路径/api')).to.equal(
        'https://safe.global/%E8%B7%AF%E5%BE%84/api',
      );
      expect(
        normalizeSafeServiceUrl(
          'https://safe-transaction-mainnet.5afe.dev/путь',
        ),
      ).to.equal(
        'https://safe-transaction-mainnet.5afe.dev/%D0%BF%D1%83%D1%82%D1%8C/api',
      );
    });

    it('preserves /api when already present', () => {
      expect(
        normalizeSafeServiceUrl('https://safe.global/tx-service/eth/api'),
      ).to.equal('https://safe.global/tx-service/eth/api');
      expect(
        normalizeSafeServiceUrl('https://safe.global/path%40foo/api'),
      ).to.equal('https://safe.global/path%40foo/api');
    });

    it('normalizes trailing slash on /api urls', () => {
      expect(
        normalizeSafeServiceUrl('https://safe.global/tx-service/eth/api/'),
      ).to.equal('https://safe.global/tx-service/eth/api');
    });

    it('canonicalizes case-insensitive /api suffix to /api', () => {
      expect(
        normalizeSafeServiceUrl('https://safe.global/tx-service/eth/API'),
      ).to.equal('https://safe.global/tx-service/eth/api');
      expect(
        normalizeSafeServiceUrl('https://safe.global/tx-service/eth/Api/'),
      ).to.equal('https://safe.global/tx-service/eth/api');
    });

    it('canonicalizes /api/v2 urls to /api', () => {
      expect(
        normalizeSafeServiceUrl('https://safe.global/tx-service/eth/api/v2'),
      ).to.equal('https://safe.global/tx-service/eth/api');
      expect(
        normalizeSafeServiceUrl('https://safe.global/tx-service/eth/api/v2/'),
      ).to.equal('https://safe.global/tx-service/eth/api');
      expect(
        normalizeSafeServiceUrl('https://safe.global/tx-service/eth/API/V2/'),
      ).to.equal('https://safe.global/tx-service/eth/api');
    });

    it('removes trailing slashes before appending', () => {
      expect(
        normalizeSafeServiceUrl('https://transaction.foo.xyz///'),
      ).to.equal('https://transaction.foo.xyz/api');
    });

    it('trims surrounding whitespace before normalization', () => {
      expect(
        normalizeSafeServiceUrl('  https://safe.global/tx-service/eth/api/  '),
      ).to.equal('https://safe.global/tx-service/eth/api');
    });

    it('normalizes host-only service urls by inferring https', () => {
      expect(normalizeSafeServiceUrl('safe.global')).to.equal(
        'https://safe.global/api',
      );
      expect(normalizeSafeServiceUrl('//safe.global')).to.equal(
        'https://safe.global/api',
      );
      expect(normalizeSafeServiceUrl('//safe.global:443/api')).to.equal(
        'https://safe.global/api',
      );
      expect(normalizeSafeServiceUrl('//SAFE.GLOBAL:443/API')).to.equal(
        'https://safe.global/api',
      );
      expect(normalizeSafeServiceUrl('//safe.global./api')).to.equal(
        'https://safe.global./api',
      );
      expect(normalizeSafeServiceUrl('safe.global/')).to.equal(
        'https://safe.global/api',
      );
      expect(normalizeSafeServiceUrl('safe.global:443/api')).to.equal(
        'https://safe.global/api',
      );
      expect(normalizeSafeServiceUrl('safe.global:80/api')).to.equal(
        'https://safe.global:80/api',
      );
      expect(normalizeSafeServiceUrl('safe.global/path@foo')).to.equal(
        'https://safe.global/path@foo/api',
      );
      expect(normalizeSafeServiceUrl('safe.global/path%40foo')).to.equal(
        'https://safe.global/path%40foo/api',
      );
      expect(normalizeSafeServiceUrl('safe.global/path%5Cfoo')).to.equal(
        'https://safe.global/path%5Cfoo/api',
      );
      expect(normalizeSafeServiceUrl('safe.global/path%255Cfoo')).to.equal(
        'https://safe.global/path%255Cfoo/api',
      );
      expect(normalizeSafeServiceUrl('safe.global/path%25255Cfoo')).to.equal(
        'https://safe.global/path%25255Cfoo/api',
      );
      expect(normalizeSafeServiceUrl('safe.global/path%25255cfoo')).to.equal(
        'https://safe.global/path%25255cfoo/api',
      );
      expect(
        normalizeSafeServiceUrl(
          'safe-transaction-mainnet.5afe.dev/path%25255cfoo',
        ),
      ).to.equal(
        'https://safe-transaction-mainnet.5afe.dev/path%25255cfoo/api',
      );
      expect(normalizeSafeServiceUrl('safe.global/path%252540foo')).to.equal(
        'https://safe.global/path%252540foo/api',
      );
      expect(normalizeSafeServiceUrl('safe.global/path%25252540foo')).to.equal(
        'https://safe.global/path%25252540foo/api',
      );
      expect(
        normalizeSafeServiceUrl(
          'SAFE.GLOBAL/PATH%40FOO?email=user%40hyperlane.xyz#frag',
        ),
      ).to.equal('https://safe.global/PATH%40FOO/api');
      expect(
        normalizeSafeServiceUrl('safe.global?email=user@hyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('safe.global?email=user%40hyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('safe.global?email=user%2540hyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('safe.global?email=user%252540hyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('safe.global?email=user%25252540hyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('safe.global?note=user%5Chyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('safe.global?note=user%255Chyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('safe.global?note=user%25255Chyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('safe.global?note=user%255chyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('safe.global?note=user%25255chyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl(
          'safe-transaction-mainnet.5afe.dev?note=user%25255chyperlane.xyz',
        ),
      ).to.equal('https://safe-transaction-mainnet.5afe.dev/api');
      expect(
        normalizeSafeServiceUrl('safe.global#user@hyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('safe.global#user%40hyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('safe.global#user%252540hyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('safe.global#user%25252540hyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('safe.global#note%5Chyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('safe.global#note%255Chyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('safe.global#note%25255Chyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('safe.global#note%255chyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('safe.global#note%25255chyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl(
          'safe-transaction-mainnet.5afe.dev#note%25255chyperlane.xyz',
        ),
      ).to.equal('https://safe-transaction-mainnet.5afe.dev/api');
      expect(
        normalizeSafeServiceUrl(
          'SAFE.GLOBAL?email=user%40hyperlane.xyz#user%40hyperlane.xyz',
        ),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl(
          'safe.global:443?email=user@hyperlane.xyz#user@hyperlane.xyz',
        ),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl(
          'safe.global:443?email=user%40hyperlane.xyz#user%40hyperlane.xyz',
        ),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl(
          'safe.global:8443?email=user@hyperlane.xyz#user@hyperlane.xyz',
        ),
      ).to.equal('https://safe.global:8443/api');
      expect(
        normalizeSafeServiceUrl(
          'safe.global:8443?email=user%40hyperlane.xyz#user%40hyperlane.xyz',
        ),
      ).to.equal('https://safe.global:8443/api');
      expect(
        normalizeSafeServiceUrl(
          'SAFE.GLOBAL:8443?email=user%40hyperlane.xyz#user%40hyperlane.xyz',
        ),
      ).to.equal('https://safe.global:8443/api');
      expect(normalizeSafeServiceUrl('safe.global/tx-service/eth')).to.equal(
        'https://safe.global/tx-service/eth/api',
      );
      expect(
        normalizeSafeServiceUrl('safe.global/tx-service/eth?foo=bar#fragment'),
      ).to.equal('https://safe.global/tx-service/eth/api');
      expect(normalizeSafeServiceUrl('//safe.global/tx-service/eth')).to.equal(
        'https://safe.global/tx-service/eth/api',
      );
      expect(
        normalizeSafeServiceUrl(
          '//safe.global/tx-service/eth?foo=bar#fragment',
        ),
      ).to.equal('https://safe.global/tx-service/eth/api');
      expect(
        normalizeSafeServiceUrl(
          '//safe.global:8443/tx-service/eth?foo=bar#fragment',
        ),
      ).to.equal('https://safe.global:8443/tx-service/eth/api');
      expect(normalizeSafeServiceUrl('//safe.global?foo=bar')).to.equal(
        'https://safe.global/api',
      );
      expect(
        normalizeSafeServiceUrl('//safe.global?email=user@hyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('//safe.global#user@hyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('//safe.global/#user@hyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('//safe.global#user%252540hyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('//safe.global#user%25252540hyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('//safe.global#note%5Chyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('//safe.global#note%255Chyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('//safe.global#note%25255Chyperlane.xyz'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl('//safe.global/tx-service/path@foo'),
      ).to.equal('https://safe.global/tx-service/path@foo/api');
      expect(
        normalizeSafeServiceUrl('//safe.global/tx-service/path%40foo'),
      ).to.equal('https://safe.global/tx-service/path%40foo/api');
      expect(normalizeSafeServiceUrl('//safe.global/path%5Cfoo')).to.equal(
        'https://safe.global/path%5Cfoo/api',
      );
      expect(normalizeSafeServiceUrl('//safe.global/path%255Cfoo')).to.equal(
        'https://safe.global/path%255Cfoo/api',
      );
      expect(normalizeSafeServiceUrl('//safe.global/path%25255Cfoo')).to.equal(
        'https://safe.global/path%25255Cfoo/api',
      );
      expect(normalizeSafeServiceUrl('//safe.global/path%25255cfoo')).to.equal(
        'https://safe.global/path%25255cfoo/api',
      );
      expect(
        normalizeSafeServiceUrl(
          '//safe-transaction-mainnet.5afe.dev/path%25255cfoo',
        ),
      ).to.equal(
        'https://safe-transaction-mainnet.5afe.dev/path%25255cfoo/api',
      );
      expect(normalizeSafeServiceUrl('//safe.global/path%252540foo')).to.equal(
        'https://safe.global/path%252540foo/api',
      );
      expect(
        normalizeSafeServiceUrl('//safe.global/path%25252540foo'),
      ).to.equal('https://safe.global/path%25252540foo/api');
      expect(
        normalizeSafeServiceUrl(
          '//SAFE.GLOBAL/TX-SERVICE/PATH%40FOO?email=user%40hyperlane.xyz#user%40hyperlane.xyz',
        ),
      ).to.equal('https://safe.global/TX-SERVICE/PATH%40FOO/api');
      expect(
        normalizeSafeServiceUrl('//safe.global/api?label=@safe#fragment'),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl(
          '//safe.global/api?email=user%40hyperlane.xyz#fragment',
        ),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl(
          '//safe.global/api?email=user%2540hyperlane.xyz#fragment',
        ),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl(
          '//safe.global/api?email=user%252540hyperlane.xyz#fragment',
        ),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl(
          '//safe.global/api?email=user%25252540hyperlane.xyz#fragment',
        ),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl(
          '//safe.global/api?note=user%5Chyperlane.xyz#note%5Chyperlane.xyz',
        ),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl(
          '//safe.global/api?note=user%255Chyperlane.xyz#note%255Chyperlane.xyz',
        ),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl(
          '//safe.global/api?note=user%25255Chyperlane.xyz#note%25255Chyperlane.xyz',
        ),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl(
          '//safe.global/api?note=user%255chyperlane.xyz#note%255chyperlane.xyz',
        ),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl(
          '//safe.global/api?note=user%25255chyperlane.xyz#note%25255chyperlane.xyz',
        ),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl(
          '//safe-transaction-mainnet.5afe.dev/api?note=user%25255chyperlane.xyz#note%25255chyperlane.xyz',
        ),
      ).to.equal('https://safe-transaction-mainnet.5afe.dev/api');
      expect(
        normalizeSafeServiceUrl(
          '//SAFE.GLOBAL?email=user%40hyperlane.xyz#user%40hyperlane.xyz',
        ),
      ).to.equal('https://safe.global/api');
    });

    it('preserves explicit non-default ports during normalization', () => {
      expect(
        normalizeSafeServiceUrl('https://safe.global:8443/tx-service/eth'),
      ).to.equal('https://safe.global:8443/tx-service/eth/api');
      expect(
        normalizeSafeServiceUrl('https://safe.global:80/tx-service/eth'),
      ).to.equal('https://safe.global:80/tx-service/eth/api');
      expect(
        normalizeSafeServiceUrl('safe.global:8443/tx-service/eth'),
      ).to.equal('https://safe.global:8443/tx-service/eth/api');
      expect(
        normalizeSafeServiceUrl('http://safe.global:443/tx-service/eth'),
      ).to.equal('http://safe.global:443/tx-service/eth/api');
    });

    it('preserves explicit http scheme during normalization', () => {
      expect(
        normalizeSafeServiceUrl('http://safe.global/tx-service/eth'),
      ).to.equal('http://safe.global/tx-service/eth/api');
      expect(
        normalizeSafeServiceUrl('http://safe.global/api?foo=bar#frag'),
      ).to.equal('http://safe.global/api');
      expect(normalizeSafeServiceUrl('http://safe.global:80/api')).to.equal(
        'http://safe.global/api',
      );
      expect(normalizeSafeServiceUrl('http://safe.global:8080/api')).to.equal(
        'http://safe.global:8080/api',
      );
      expect(
        normalizeSafeServiceUrl('http://safe.global:80/tx-service/eth'),
      ).to.equal('http://safe.global/tx-service/eth/api');
      expect(normalizeSafeServiceUrl('HTTP://SAFE.GLOBAL:80/API')).to.equal(
        'http://safe.global/api',
      );
      expect(normalizeSafeServiceUrl('https://safe.global:443/api')).to.equal(
        'https://safe.global/api',
      );
      expect(
        normalizeSafeServiceUrl('https://safe.global:443/tx-service/eth'),
      ).to.equal('https://safe.global/tx-service/eth/api');
      expect(
        normalizeSafeServiceUrl('HTTPS://SAFE.GLOBAL:443/TX-SERVICE/ETH/API'),
      ).to.equal('https://safe.global/TX-SERVICE/ETH/api');
    });

    it('canonicalizes explicit http(s) urls with extra slashes', () => {
      expect(
        normalizeSafeServiceUrl('https:////safe.global/tx-service/eth'),
      ).to.equal('https://safe.global/tx-service/eth/api');
      expect(normalizeSafeServiceUrl('http:///safe.global/api')).to.equal(
        'http://safe.global/api',
      );
      expect(
        normalizeSafeServiceUrl(
          'https:////safe.global/api?email=user%25252540hyperlane.xyz',
        ),
      ).to.equal('https://safe.global/api');
      expect(
        normalizeSafeServiceUrl(
          'http:///safe.global#user%25252540hyperlane.xyz',
        ),
      ).to.equal('http://safe.global/api');
      expect(
        normalizeSafeServiceUrl(
          'https:////safe-transaction-mainnet.5afe.dev/path%252540foo',
        ),
      ).to.equal(
        'https://safe-transaction-mainnet.5afe.dev/path%252540foo/api',
      );
    });

    it('throws when a non-http scheme is provided explicitly', () => {
      expect(() => normalizeSafeServiceUrl('ftp://safe.global')).to.throw(
        'Safe tx service URL must use http(s): ftp://safe.global',
      );
      expect(() => normalizeSafeServiceUrl('ws://safe.global')).to.throw(
        'Safe tx service URL must use http(s): ws://safe.global',
      );
      expect(() => normalizeSafeServiceUrl('mailto:safe.global')).to.throw(
        'Safe tx service URL must use http(s): mailto:safe.global',
      );
      expect(() =>
        normalizeSafeServiceUrl('data:text/plain,safe.global'),
      ).to.throw(
        'Safe tx service URL must use http(s): data:text/plain,safe.global',
      );
      expect(() => normalizeSafeServiceUrl('foo:/safe.global')).to.throw(
        'Safe tx service URL must use http(s): foo:/safe.global',
      );
      expect(() =>
        normalizeSafeServiceUrl('urn:safe-transaction-mainnet.safe.global'),
      ).to.throw(
        'Safe tx service URL must use http(s): urn:safe-transaction-mainnet.safe.global',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'blob:https://safe-transaction-mainnet.safe.global',
        ),
      ).to.throw(
        'Safe tx service URL must use http(s): blob:https://safe-transaction-mainnet.safe.global',
      );
    });

    it('throws when explicit http(s) url is malformed', () => {
      expect(() => normalizeSafeServiceUrl('https://')).to.throw(
        'Safe tx service URL is invalid: https://',
      );
      expect(() => normalizeSafeServiceUrl('https:/safe.global/api')).to.throw(
        'Safe tx service URL is invalid: https:/safe.global/api',
      );
      expect(() => normalizeSafeServiceUrl('http:/safe.global/api')).to.throw(
        'Safe tx service URL is invalid: http:/safe.global/api',
      );
      expect(() => normalizeSafeServiceUrl('https:/@safe.global/api')).to.throw(
        'Safe tx service URL is invalid: https:/@safe.global/api',
      );
      expect(() => normalizeSafeServiceUrl('http:/@safe.global/api')).to.throw(
        'Safe tx service URL is invalid: http:/@safe.global/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https:\\safe.global\\api'),
      ).to.throw('Safe tx service URL is invalid: https:\\safe.global\\api');
      expect(() =>
        normalizeSafeServiceUrl(
          'http:\\safe-transaction-mainnet.5afe.dev\\api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: http:\\safe-transaction-mainnet.5afe.dev\\api',
      );
      expect(() => normalizeSafeServiceUrl('https:\\safe.global/api')).to.throw(
        'Safe tx service URL is invalid: https:\\safe.global/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('http:\\safe-transaction-mainnet.5afe.dev/api'),
      ).to.throw(
        'Safe tx service URL is invalid: http:\\safe-transaction-mainnet.5afe.dev/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https:\\\\safe.global/api'),
      ).to.throw('Safe tx service URL is invalid: https:\\\\safe.global/api');
      expect(() =>
        normalizeSafeServiceUrl(
          'http:\\\\safe-transaction-mainnet.5afe.dev/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: http:\\\\safe-transaction-mainnet.5afe.dev/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https:\\//safe.global/api'),
      ).to.throw('Safe tx service URL is invalid: https:\\//safe.global/api');
      expect(() =>
        normalizeSafeServiceUrl(
          'http:\\//safe-transaction-mainnet.5afe.dev/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: http:\\//safe-transaction-mainnet.5afe.dev/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https://safe.global\\api'),
      ).to.throw('Safe tx service URL is invalid: https://safe.global\\api');
      expect(() =>
        normalizeSafeServiceUrl(
          'http://safe-transaction-mainnet.5afe.dev\\api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: http://safe-transaction-mainnet.5afe.dev\\api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https://safe.global\\?foo=bar'),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global\\?foo=bar',
      );
      expect(() =>
        normalizeSafeServiceUrl('https:/safe-transaction-mainnet.5afe.dev'),
      ).to.throw(
        'Safe tx service URL is invalid: https:/safe-transaction-mainnet.5afe.dev',
      );
      expect(() =>
        normalizeSafeServiceUrl('http:/safe-transaction-mainnet.5afe.dev'),
      ).to.throw(
        'Safe tx service URL is invalid: http:/safe-transaction-mainnet.5afe.dev',
      );
      expect(() =>
        normalizeSafeServiceUrl('https:/@safe-transaction-mainnet.5afe.dev'),
      ).to.throw(
        'Safe tx service URL is invalid: https:/@safe-transaction-mainnet.5afe.dev',
      );
      expect(() =>
        normalizeSafeServiceUrl('http:/@safe-transaction-mainnet.5afe.dev'),
      ).to.throw(
        'Safe tx service URL is invalid: http:/@safe-transaction-mainnet.5afe.dev',
      );
      expect(() => normalizeSafeServiceUrl('http://:443')).to.throw(
        'Safe tx service URL is invalid: http://:443',
      );
      expect(() => normalizeSafeServiceUrl('foo:bar')).to.throw(
        'Safe tx service URL must use http(s): foo:bar',
      );
      expect(() => normalizeSafeServiceUrl('https://?foo=bar')).to.throw(
        'Safe tx service URL is invalid: https://?foo=bar',
      );
      expect(() => normalizeSafeServiceUrl('/tx-service/eth')).to.throw(
        'Safe tx service URL is invalid: /tx-service/eth',
      );
      expect(() =>
        normalizeSafeServiceUrl('  /tx-service/eth?foo=bar  '),
      ).to.throw('Safe tx service URL is invalid: /tx-service/eth?foo=bar');
      expect(() => normalizeSafeServiceUrl('///safe.global/api')).to.throw(
        'Safe tx service URL is invalid: ///safe.global/api',
      );
      expect(() => normalizeSafeServiceUrl('safe.global\\evil.com')).to.throw(
        'Safe tx service URL is invalid: safe.global\\evil.com',
      );
      expect(() => normalizeSafeServiceUrl('//safe.global\\evil.com')).to.throw(
        'Safe tx service URL is invalid: //safe.global\\evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl('safe-transaction-mainnet.5afe.dev\\foo'),
      ).to.throw(
        'Safe tx service URL is invalid: safe-transaction-mainnet.5afe.dev\\foo',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe-transaction-mainnet.5afe.dev\\foo'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe-transaction-mainnet.5afe.dev\\foo',
      );
      expect(() =>
        normalizeSafeServiceUrl('https:////\\safe.global/api'),
      ).to.throw('Safe tx service URL is invalid: https:////\\safe.global/api');
      expect(() =>
        normalizeSafeServiceUrl(
          'http:////\\safe-transaction-mainnet.5afe.dev/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: http:////\\safe-transaction-mainnet.5afe.dev/api',
      );
      expect(() => normalizeSafeServiceUrl('//')).to.throw(
        'Safe tx service URL is invalid: //',
      );
      expect(() => normalizeSafeServiceUrl('//?foo=bar')).to.throw(
        'Safe tx service URL is invalid: //?foo=bar',
      );
      expect(() => normalizeSafeServiceUrl('//safe.global:abc')).to.throw(
        'Safe tx service URL is invalid: //safe.global:abc',
      );
      expect(() => normalizeSafeServiceUrl('//safe.global:99999')).to.throw(
        'Safe tx service URL is invalid: //safe.global:99999',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global@evil.com/api'),
      ).to.throw('Safe tx service URL is invalid: //safe.global@evil.com/api');
      expect(() => normalizeSafeServiceUrl('//safe.global@evil.com')).to.throw(
        'Safe tx service URL is invalid: //safe.global@evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global@evil.com?foo=bar'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global@evil.com?foo=bar',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global@evil.com#frag'),
      ).to.throw('Safe tx service URL is invalid: //safe.global@evil.com#frag');
      expect(() =>
        normalizeSafeServiceUrl('https://safe.global%40evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global%40evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('http://safe.global%40evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: http://safe.global%40evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https://@safe.global/api'),
      ).to.throw('Safe tx service URL is invalid: https://@safe.global/api');
      expect(() => normalizeSafeServiceUrl('http://@safe.global/api')).to.throw(
        'Safe tx service URL is invalid: http://@safe.global/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https://:@safe.global/api'),
      ).to.throw('Safe tx service URL is invalid: https://:@safe.global/api');
      expect(() =>
        normalizeSafeServiceUrl('http://:@safe.global/api'),
      ).to.throw('Safe tx service URL is invalid: http://:@safe.global/api');
      expect(() =>
        normalizeSafeServiceUrl('https://safe.global@evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global@evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('http://safe.global@evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: http://safe.global@evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('http:///safe.global@evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: http:///safe.global@evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https:////safe.global@evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: https:////safe.global@evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https:////@safe.global/api'),
      ).to.throw('Safe tx service URL is invalid: https:////@safe.global/api');
      expect(() =>
        normalizeSafeServiceUrl('http:////@safe.global/api'),
      ).to.throw('Safe tx service URL is invalid: http:////@safe.global/api');
      expect(() =>
        normalizeSafeServiceUrl('http:///safe.global%2540evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: http:///safe.global%2540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https:////safe.global%252540evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: https:////safe.global%252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https://safe.global%2540evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global%2540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https://safe.global%5C@evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global%5C@evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https://safe.global%255C@evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global%255C@evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https://safe.global%25255C@evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global%25255C@evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https://safe.global%255c%40evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global%255c%40evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https://safe.global%25255c%40evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global%25255c%40evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https://safe.global%255C%40evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global%255C%40evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https://safe.global%25255C%40evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global%25255C%40evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https://safe.global%255c%2540evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global%255c%2540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https://safe.global%255C%2540evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global%255C%2540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https://safe.global%255c%252540evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global%255c%252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https://safe.global%255C%252540evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global%255C%252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'https://safe.global%255c%25252540evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global%255c%25252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'https://safe.global%255C%25252540evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global%255C%25252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'https://safe.global%255c%2525252540evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global%255c%2525252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'https://safe.global%255C%2525252540evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global%255C%2525252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https://safe.global%255c@evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global%255c@evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('https://safe.global%25255c@evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global%25255c@evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%5C@evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global%5C@evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%255C@evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global%255C@evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%25255C@evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global%25255C@evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%255c%40evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global%255c%40evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%25255c%40evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global%25255c%40evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%255C%40evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global%255C%40evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%25255C%40evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global%25255C%40evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%255c%2540evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global%255c%2540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%255C%2540evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global%255C%2540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%255c%252540evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global%255c%252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%255C%252540evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global%255C%252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%255c%25252540evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global%255c%25252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%255C%25252540evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global%255C%25252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%255c%2525252540evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global%255c%2525252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%255C%2525252540evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global%255C%2525252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%255c@evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global%255c@evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%25255c@evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global%25255c@evil.com/api',
      );
      expect(() => normalizeSafeServiceUrl('safe.global%5C@evil.com')).to.throw(
        'Safe tx service URL is invalid: safe.global%5C@evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl('safe.global%255C@evil.com'),
      ).to.throw('Safe tx service URL is invalid: safe.global%255C@evil.com');
      expect(() =>
        normalizeSafeServiceUrl('safe.global%25255C@evil.com'),
      ).to.throw('Safe tx service URL is invalid: safe.global%25255C@evil.com');
      expect(() =>
        normalizeSafeServiceUrl('safe.global%25255c%40evil.com'),
      ).to.throw(
        'Safe tx service URL is invalid: safe.global%25255c%40evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl('safe.global%255C%40evil.com'),
      ).to.throw('Safe tx service URL is invalid: safe.global%255C%40evil.com');
      expect(() =>
        normalizeSafeServiceUrl('safe.global%25255C%40evil.com'),
      ).to.throw(
        'Safe tx service URL is invalid: safe.global%25255C%40evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl('safe.global%255c%2540evil.com'),
      ).to.throw(
        'Safe tx service URL is invalid: safe.global%255c%2540evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl('safe.global%255C%2540evil.com'),
      ).to.throw(
        'Safe tx service URL is invalid: safe.global%255C%2540evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl('safe.global%255c%252540evil.com'),
      ).to.throw(
        'Safe tx service URL is invalid: safe.global%255c%252540evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl('safe.global%255C%252540evil.com'),
      ).to.throw(
        'Safe tx service URL is invalid: safe.global%255C%252540evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl('safe.global%255c%25252540evil.com'),
      ).to.throw(
        'Safe tx service URL is invalid: safe.global%255c%25252540evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl('safe.global%255C%25252540evil.com'),
      ).to.throw(
        'Safe tx service URL is invalid: safe.global%255C%25252540evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl('safe.global%255c%2525252540evil.com'),
      ).to.throw(
        'Safe tx service URL is invalid: safe.global%255c%2525252540evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl('safe.global%255C%2525252540evil.com'),
      ).to.throw(
        'Safe tx service URL is invalid: safe.global%255C%2525252540evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl('safe.global%255c@evil.com'),
      ).to.throw('Safe tx service URL is invalid: safe.global%255c@evil.com');
      expect(() =>
        normalizeSafeServiceUrl('safe.global%25255c@evil.com'),
      ).to.throw('Safe tx service URL is invalid: safe.global%25255c@evil.com');
      expect(() =>
        normalizeSafeServiceUrl('https://safe.global%25252540evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe.global%25252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'https://safe-transaction-mainnet.5afe.dev%5C@evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe-transaction-mainnet.5afe.dev%5C@evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'https://safe-transaction-mainnet.5afe.dev%255c%40evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe-transaction-mainnet.5afe.dev%255c%40evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'https://safe-transaction-mainnet.5afe.dev%25255c%40evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe-transaction-mainnet.5afe.dev%25255c%40evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'https://safe-transaction-mainnet.5afe.dev%255C%40evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe-transaction-mainnet.5afe.dev%255C%40evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'https://safe-transaction-mainnet.5afe.dev%25255C%40evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe-transaction-mainnet.5afe.dev%25255C%40evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'https://safe-transaction-mainnet.5afe.dev%255c%2540evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe-transaction-mainnet.5afe.dev%255c%2540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'https://safe-transaction-mainnet.5afe.dev%255C%2540evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe-transaction-mainnet.5afe.dev%255C%2540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'https://safe-transaction-mainnet.5afe.dev%255c%252540evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe-transaction-mainnet.5afe.dev%255c%252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'https://safe-transaction-mainnet.5afe.dev%255C%252540evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe-transaction-mainnet.5afe.dev%255C%252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'https://safe-transaction-mainnet.5afe.dev%255c%25252540evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe-transaction-mainnet.5afe.dev%255c%25252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'https://safe-transaction-mainnet.5afe.dev%255C%25252540evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe-transaction-mainnet.5afe.dev%255C%25252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'https://safe-transaction-mainnet.5afe.dev%255c%2525252540evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe-transaction-mainnet.5afe.dev%255c%2525252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'https://safe-transaction-mainnet.5afe.dev%255C%2525252540evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe-transaction-mainnet.5afe.dev%255C%2525252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'https://safe-transaction-mainnet.5afe.dev%255c@evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe-transaction-mainnet.5afe.dev%255c@evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'https://safe-transaction-mainnet.5afe.dev%25255c@evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe-transaction-mainnet.5afe.dev%25255c@evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'https:////safe-transaction-mainnet.5afe.dev%5C@evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: https:////safe-transaction-mainnet.5afe.dev%5C@evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          '//safe-transaction-mainnet.5afe.dev%255c%40evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: //safe-transaction-mainnet.5afe.dev%255c%40evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          '//safe-transaction-mainnet.5afe.dev%25255c%40evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: //safe-transaction-mainnet.5afe.dev%25255c%40evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          '//safe-transaction-mainnet.5afe.dev%255C%40evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: //safe-transaction-mainnet.5afe.dev%255C%40evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          '//safe-transaction-mainnet.5afe.dev%25255C%40evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: //safe-transaction-mainnet.5afe.dev%25255C%40evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          '//safe-transaction-mainnet.5afe.dev%255c%2540evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: //safe-transaction-mainnet.5afe.dev%255c%2540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          '//safe-transaction-mainnet.5afe.dev%255C%2540evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: //safe-transaction-mainnet.5afe.dev%255C%2540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          '//safe-transaction-mainnet.5afe.dev%255c%252540evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: //safe-transaction-mainnet.5afe.dev%255c%252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          '//safe-transaction-mainnet.5afe.dev%255C%252540evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: //safe-transaction-mainnet.5afe.dev%255C%252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          '//safe-transaction-mainnet.5afe.dev%255c%25252540evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: //safe-transaction-mainnet.5afe.dev%255c%25252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          '//safe-transaction-mainnet.5afe.dev%255C%25252540evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: //safe-transaction-mainnet.5afe.dev%255C%25252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          '//safe-transaction-mainnet.5afe.dev%255c%2525252540evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: //safe-transaction-mainnet.5afe.dev%255c%2525252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          '//safe-transaction-mainnet.5afe.dev%255C%2525252540evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: //safe-transaction-mainnet.5afe.dev%255C%2525252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          '//safe-transaction-mainnet.5afe.dev%255c@evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: //safe-transaction-mainnet.5afe.dev%255c@evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          '//safe-transaction-mainnet.5afe.dev%25255c@evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: //safe-transaction-mainnet.5afe.dev%25255c@evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'safe-transaction-mainnet.5afe.dev%255c%40evil.com',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: safe-transaction-mainnet.5afe.dev%255c%40evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'safe-transaction-mainnet.5afe.dev%25255c%40evil.com',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: safe-transaction-mainnet.5afe.dev%25255c%40evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'safe-transaction-mainnet.5afe.dev%255C%40evil.com',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: safe-transaction-mainnet.5afe.dev%255C%40evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'safe-transaction-mainnet.5afe.dev%25255C%40evil.com',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: safe-transaction-mainnet.5afe.dev%25255C%40evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'safe-transaction-mainnet.5afe.dev%255c%2540evil.com',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: safe-transaction-mainnet.5afe.dev%255c%2540evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'safe-transaction-mainnet.5afe.dev%255C%2540evil.com',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: safe-transaction-mainnet.5afe.dev%255C%2540evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'safe-transaction-mainnet.5afe.dev%255c%252540evil.com',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: safe-transaction-mainnet.5afe.dev%255c%252540evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'safe-transaction-mainnet.5afe.dev%255C%252540evil.com',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: safe-transaction-mainnet.5afe.dev%255C%252540evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'safe-transaction-mainnet.5afe.dev%255c%25252540evil.com',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: safe-transaction-mainnet.5afe.dev%255c%25252540evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'safe-transaction-mainnet.5afe.dev%255C%25252540evil.com',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: safe-transaction-mainnet.5afe.dev%255C%25252540evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'safe-transaction-mainnet.5afe.dev%255c%2525252540evil.com',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: safe-transaction-mainnet.5afe.dev%255c%2525252540evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'safe-transaction-mainnet.5afe.dev%255C%2525252540evil.com',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: safe-transaction-mainnet.5afe.dev%255C%2525252540evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'safe-transaction-mainnet.5afe.dev%255c@evil.com',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: safe-transaction-mainnet.5afe.dev%255c@evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'safe-transaction-mainnet.5afe.dev%25255c@evil.com',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: safe-transaction-mainnet.5afe.dev%25255c@evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl('http://safe.global%252540evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: http://safe.global%252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('http://safe.global%25252540evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: http://safe.global%25252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          'https://safe-transaction-mainnet.5afe.dev%252540evil.com/api',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: https://safe-transaction-mainnet.5afe.dev%252540evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%40evil.com/api'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global%40evil.com/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%40evil.com:443/api'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global%40evil.com:443/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%40evil.com'),
      ).to.throw('Safe tx service URL is invalid: //safe.global%40evil.com');
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%2540evil.com'),
      ).to.throw('Safe tx service URL is invalid: //safe.global%2540evil.com');
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%2540evil.com:443/api'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global%2540evil.com:443/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//safe.global%252540evil.com'),
      ).to.throw(
        'Safe tx service URL is invalid: //safe.global%252540evil.com',
      );
      expect(() => normalizeSafeServiceUrl('safe.global%40evil.com')).to.throw(
        'Safe tx service URL is invalid: safe.global%40evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl('safe.global%2540evil.com'),
      ).to.throw('Safe tx service URL is invalid: safe.global%2540evil.com');
      expect(() =>
        normalizeSafeServiceUrl('safe.global%252540evil.com'),
      ).to.throw('Safe tx service URL is invalid: safe.global%252540evil.com');
      expect(() =>
        normalizeSafeServiceUrl('safe.global%40evil.com:443/api'),
      ).to.throw(
        'Safe tx service URL is invalid: safe.global%40evil.com:443/api',
      );
      expect(() => normalizeSafeServiceUrl('safe.global@evil.com')).to.throw(
        'Safe tx service URL is invalid: safe.global@evil.com',
      );
      expect(() =>
        normalizeSafeServiceUrl('safe.global@evil.com:443/api'),
      ).to.throw(
        'Safe tx service URL is invalid: safe.global@evil.com:443/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('safe.global@evil.com?foo=bar'),
      ).to.throw(
        'Safe tx service URL is invalid: safe.global@evil.com?foo=bar',
      );
      expect(() =>
        normalizeSafeServiceUrl('safe.global@evil.com#frag'),
      ).to.throw('Safe tx service URL is invalid: safe.global@evil.com#frag');
      expect(() => normalizeSafeServiceUrl('//safe.global:')).to.throw(
        'Safe tx service URL is invalid: //safe.global:',
      );
      expect(() => normalizeSafeServiceUrl('//safe.global:/api')).to.throw(
        'Safe tx service URL is invalid: //safe.global:/api',
      );
      expect(() => normalizeSafeServiceUrl('//safe.global:/#frag')).to.throw(
        'Safe tx service URL is invalid: //safe.global:/#frag',
      );
      expect(() => normalizeSafeServiceUrl('//safe.global:#frag')).to.throw(
        'Safe tx service URL is invalid: //safe.global:#frag',
      );
      expect(() => normalizeSafeServiceUrl('//:pass@safe.global/api')).to.throw(
        'Safe tx service URL is invalid: //:pass@safe.global/api',
      );
      expect(() => normalizeSafeServiceUrl('//@safe.global/api')).to.throw(
        'Safe tx service URL is invalid: //@safe.global/api',
      );
      expect(() =>
        normalizeSafeServiceUrl('//user:pass@safe.global/api'),
      ).to.throw('Safe tx service URL is invalid: //user:pass@safe.global/api');
      expect(() =>
        normalizeSafeServiceUrl('//user:pass@safe.global:443/api'),
      ).to.throw(
        'Safe tx service URL is invalid: //user:pass@safe.global:443/api',
      );
      expect(() => normalizeSafeServiceUrl('//user@safe.global/api')).to.throw(
        'Safe tx service URL is invalid: //user@safe.global/api',
      );
      expect(() => normalizeSafeServiceUrl('//user:@safe.global/api')).to.throw(
        'Safe tx service URL is invalid: //user:@safe.global/api',
      );
      expect(() => normalizeSafeServiceUrl('//user:pass@/api')).to.throw(
        'Safe tx service URL is invalid: //user:pass@/api',
      );
      expect(() => normalizeSafeServiceUrl('safe.global:')).to.throw(
        'Safe tx service URL must use http(s): safe.global:',
      );
      expect(() =>
        normalizeSafeServiceUrl(
          '///safe-transaction-mainnet.safe.global/tx-service/eth',
        ),
      ).to.throw(
        'Safe tx service URL is invalid: ///safe-transaction-mainnet.safe.global/tx-service/eth',
      );
      expect(() => normalizeSafeServiceUrl('not a url')).to.throw(
        'Safe tx service URL is invalid: not a url',
      );
    });

    it('drops query and hash components during normalization', () => {
      expect(
        normalizeSafeServiceUrl(
          'https://safe.global/tx-service/eth/api/?foo=bar#fragment',
        ),
      ).to.equal('https://safe.global/tx-service/eth/api');
      expect(
        normalizeSafeServiceUrl('https://safe.global/tx-service/eth?foo=bar'),
      ).to.equal('https://safe.global/tx-service/eth/api');
      expect(
        normalizeSafeServiceUrl(
          'https://safe.global/tx-service/eth/api?email=user@hyperlane.xyz#user@hyperlane.xyz',
        ),
      ).to.equal('https://safe.global/tx-service/eth/api');
      expect(
        normalizeSafeServiceUrl(
          'https://safe.global/tx-service/eth/api?email=user%40hyperlane.xyz#user%40hyperlane.xyz',
        ),
      ).to.equal('https://safe.global/tx-service/eth/api');
      expect(
        normalizeSafeServiceUrl(
          'https://safe.global/tx-service/eth/api?email=user%25252540hyperlane.xyz#user%25252540hyperlane.xyz',
        ),
      ).to.equal('https://safe.global/tx-service/eth/api');
      expect(
        normalizeSafeServiceUrl(
          'https://safe.global/tx-service/eth/api?note=user%5Chyperlane.xyz#note%5Chyperlane.xyz',
        ),
      ).to.equal('https://safe.global/tx-service/eth/api');
      expect(
        normalizeSafeServiceUrl(
          'https://safe.global/tx-service/eth/api?note=user%255Chyperlane.xyz#note%255Chyperlane.xyz',
        ),
      ).to.equal('https://safe.global/tx-service/eth/api');
      expect(
        normalizeSafeServiceUrl(
          'https://safe.global/tx-service/eth/api?note=user%25255Chyperlane.xyz#note%25255Chyperlane.xyz',
        ),
      ).to.equal('https://safe.global/tx-service/eth/api');
      expect(
        normalizeSafeServiceUrl(
          'http://safe.global/tx-service/eth/api?email=user@hyperlane.xyz#user@hyperlane.xyz',
        ),
      ).to.equal('http://safe.global/tx-service/eth/api');
      expect(
        normalizeSafeServiceUrl(
          'http://safe.global/tx-service/eth/api?email=user%25252540hyperlane.xyz#user%25252540hyperlane.xyz',
        ),
      ).to.equal('http://safe.global/tx-service/eth/api');
      expect(
        normalizeSafeServiceUrl(
          'http://safe.global/tx-service/eth/api?note=user%5Chyperlane.xyz#note%5Chyperlane.xyz',
        ),
      ).to.equal('http://safe.global/tx-service/eth/api');
      expect(
        normalizeSafeServiceUrl(
          'https://safe.global/path%5Cfoo?note=user%5Chyperlane.xyz#note%5Chyperlane.xyz',
        ),
      ).to.equal('https://safe.global/path%5Cfoo/api');
      expect(
        normalizeSafeServiceUrl(
          'https://safe-transaction-mainnet.5afe.dev/api?note=user%5Chyperlane.xyz#note%5Chyperlane.xyz',
        ),
      ).to.equal('https://safe-transaction-mainnet.5afe.dev/api');
      expect(
        normalizeSafeServiceUrl(
          'https://safe-transaction-mainnet.5afe.dev/api?note=user%255chyperlane.xyz#note%255chyperlane.xyz',
        ),
      ).to.equal('https://safe-transaction-mainnet.5afe.dev/api');
      expect(
        normalizeSafeServiceUrl(
          'https://safe-transaction-mainnet.5afe.dev/api?note=user%25255chyperlane.xyz#note%25255chyperlane.xyz',
        ),
      ).to.equal('https://safe-transaction-mainnet.5afe.dev/api');
    });

    it('throws when service url is empty after trimming', () => {
      expect(() => normalizeSafeServiceUrl('')).to.throw(
        'Safe tx service URL is empty',
      );
      expect(() => normalizeSafeServiceUrl('   ')).to.throw(
        'Safe tx service URL is empty',
      );
    });

    it('throws when service url input is non-string', () => {
      expect(() => normalizeSafeServiceUrl(123)).to.throw(
        'Safe tx service URL must be a string: 123',
      );
      expect(() => normalizeSafeServiceUrl(null)).to.throw(
        'Safe tx service URL must be a string: null',
      );

      const unstringifiableUrl = {
        [Symbol.toPrimitive]: () => {
          throw new Error('boom');
        },
      };
      expect(() => normalizeSafeServiceUrl(unstringifiableUrl)).to.throw(
        'Safe tx service URL must be a string: <unstringifiable>',
      );
    });

    it('throws when authority contains percent-encoded host octets', () => {
      const encodedDots = ['%2E', '%2e', '%252E', '%252e'];

      for (const encodedDot of encodedDots) {
        const authorities = [
          `safe${encodedDot}global`,
          `safe-transaction-mainnet${encodedDot}5afe.dev`,
        ];

        for (const authority of authorities) {
          const explicitUrl = `https://${authority}/api`;
          const schemeRelativeUrl = `//${authority}/api`;
          const hostOnlyUrl = authority;
          const explicitPortUrl = `https://${authority}:443/api`;
          const schemeRelativePortUrl = `//${authority}:443/api`;
          const hostOnlyPortUrl = `${authority}:443`;

          expect(() => normalizeSafeServiceUrl(explicitUrl)).to.throw(
            `Safe tx service URL is invalid: ${explicitUrl}`,
          );
          expect(() => normalizeSafeServiceUrl(schemeRelativeUrl)).to.throw(
            `Safe tx service URL is invalid: ${schemeRelativeUrl}`,
          );
          expect(() => normalizeSafeServiceUrl(hostOnlyUrl)).to.throw(
            `Safe tx service URL is invalid: ${hostOnlyUrl}`,
          );
          expect(() => normalizeSafeServiceUrl(explicitPortUrl)).to.throw(
            `Safe tx service URL is invalid: ${explicitPortUrl}`,
          );
          expect(() => normalizeSafeServiceUrl(schemeRelativePortUrl)).to.throw(
            `Safe tx service URL is invalid: ${schemeRelativePortUrl}`,
          );
          expect(() => normalizeSafeServiceUrl(hostOnlyPortUrl)).to.throw(
            `Safe tx service URL is invalid: ${hostOnlyPortUrl}`,
          );
        }
      }
    });

    it('throws when authority contains non-ascii host characters', () => {
      const unicodeDotAuthorities = [
        'safe。global',
        'safe．global',
        'safe｡global',
        'safe-transaction-mainnet。5afe.dev',
      ];

      for (const authority of unicodeDotAuthorities) {
        const explicitUrl = `https://${authority}/api`;
        const schemeRelativeUrl = `//${authority}/api`;
        const explicitPortUrl = `https://${authority}:443/api`;
        const schemeRelativePortUrl = `//${authority}:443/api`;
        const hostOnlyPortUrl = `${authority}:443`;

        expect(() => normalizeSafeServiceUrl(explicitUrl)).to.throw(
          `Safe tx service URL is invalid: ${explicitUrl}`,
        );
        expect(() => normalizeSafeServiceUrl(schemeRelativeUrl)).to.throw(
          `Safe tx service URL is invalid: ${schemeRelativeUrl}`,
        );
        expect(() => normalizeSafeServiceUrl(authority)).to.throw(
          `Safe tx service URL is invalid: ${authority}`,
        );
        expect(() => normalizeSafeServiceUrl(explicitPortUrl)).to.throw(
          `Safe tx service URL is invalid: ${explicitPortUrl}`,
        );
        expect(() => normalizeSafeServiceUrl(schemeRelativePortUrl)).to.throw(
          `Safe tx service URL is invalid: ${schemeRelativePortUrl}`,
        );
        expect(() => normalizeSafeServiceUrl(hostOnlyPortUrl)).to.throw(
          `Safe tx service URL is invalid: ${hostOnlyPortUrl}`,
        );
      }
    });

    it('throws when authority contains control or whitespace characters', () => {
      const controlAuthorities = [
        'safe.global\t',
        'safe.global\n',
        'safe.global\r',
        'safe.\tglobal',
        'safe.\nglobal',
        'safe.global ',
        'safe-transaction-mainnet.5afe.dev\t',
      ];

      for (const authority of controlAuthorities) {
        const explicitUrl = `https://${authority}/api`;
        const schemeRelativeUrl = `//${authority}/api`;
        const hostOnlyPortUrl = `${authority}:443`;

        expect(() => normalizeSafeServiceUrl(explicitUrl)).to.throw(
          `Safe tx service URL is invalid: ${explicitUrl}`,
        );
        expect(() => normalizeSafeServiceUrl(schemeRelativeUrl)).to.throw(
          `Safe tx service URL is invalid: ${schemeRelativeUrl}`,
        );
        expect(() => normalizeSafeServiceUrl(hostOnlyPortUrl)).to.throw(
          `Safe tx service URL is invalid: ${hostOnlyPortUrl}`,
        );
      }
    });

    it('preserves percent-encoded data outside the authority', () => {
      expect(normalizeSafeServiceUrl('//safe.global/path%2Esegment')).to.equal(
        'https://safe.global/path%2Esegment/api',
      );
      expect(
        normalizeSafeServiceUrl('safe.global/path%2Esegment?next=%2Ffoo%2Ebar'),
      ).to.equal('https://safe.global/path%2Esegment/api');
      expect(
        normalizeSafeServiceUrl(
          'safe-transaction-mainnet.5afe.dev/path%2Esegment?next=%2Ffoo%2Ebar',
        ),
      ).to.equal(
        'https://safe-transaction-mainnet.5afe.dev/path%2Esegment/api',
      );
    });

    it('preserves unicode path data outside the authority', () => {
      expect(normalizeSafeServiceUrl('//safe.global/路径')).to.equal(
        'https://safe.global/%E8%B7%AF%E5%BE%84/api',
      );
      expect(normalizeSafeServiceUrl('safe.global/路径')).to.equal(
        'https://safe.global/%E8%B7%AF%E5%BE%84/api',
      );
      expect(
        normalizeSafeServiceUrl('//safe-transaction-mainnet.5afe.dev/путь'),
      ).to.equal(
        'https://safe-transaction-mainnet.5afe.dev/%D0%BF%D1%83%D1%82%D1%8C/api',
      );
      expect(
        normalizeSafeServiceUrl('safe-transaction-mainnet.5afe.dev/путь'),
      ).to.equal(
        'https://safe-transaction-mainnet.5afe.dev/%D0%BF%D1%83%D1%82%D1%8C/api',
      );
    });

    it('rejects encoded-backslash userinfo spoof patterns at deeper repeated-%25 depths', () => {
      const safeHosts = ['safe.global', 'safe-transaction-mainnet.5afe.dev'];
      const encodedBackslashes = ['%255c', '%255C'];

      for (const host of safeHosts) {
        for (const encodedBackslash of encodedBackslashes) {
          for (let depth = 5; depth <= 8; depth += 1) {
            const encodedAt = `%${'25'.repeat(depth)}40`;
            const authority = `${host}${encodedBackslash}${encodedAt}evil.com`;
            const explicitUrl = `https://${authority}/api`;
            const schemeRelativeUrl = `//${authority}/api`;

            expect(() => normalizeSafeServiceUrl(explicitUrl)).to.throw(
              `Safe tx service URL is invalid: ${explicitUrl}`,
            );
            expect(() => normalizeSafeServiceUrl(schemeRelativeUrl)).to.throw(
              `Safe tx service URL is invalid: ${schemeRelativeUrl}`,
            );
            expect(() => normalizeSafeServiceUrl(authority)).to.throw(
              `Safe tx service URL is invalid: ${authority}`,
            );
          }
        }
      }
    });

    it('rejects userinfo spoof patterns at deeper repeated-%25 depths', () => {
      const safeHosts = ['safe.global', 'safe-transaction-mainnet.5afe.dev'];

      for (const host of safeHosts) {
        for (let depth = 4; depth <= 8; depth += 1) {
          const encodedAt = `%${'25'.repeat(depth)}40`;
          const authority = `${host}${encodedAt}evil.com`;
          const explicitUrl = `https://${authority}/api`;
          const schemeRelativeUrl = `//${authority}/api`;

          expect(() => normalizeSafeServiceUrl(explicitUrl)).to.throw(
            `Safe tx service URL is invalid: ${explicitUrl}`,
          );
          expect(() => normalizeSafeServiceUrl(schemeRelativeUrl)).to.throw(
            `Safe tx service URL is invalid: ${schemeRelativeUrl}`,
          );
          expect(() => normalizeSafeServiceUrl(authority)).to.throw(
            `Safe tx service URL is invalid: ${authority}`,
          );
        }
      }
    });
  });

  describe(isLegacySafeApi.name, () => {
    const stringifyVersionForExpectation = (version: unknown): string => {
      try {
        return String(version);
      } catch {
        return '<unstringifiable>';
      }
    };

    const expectLegacyStatus = async (
      version: string,
      isLegacy: boolean,
    ): Promise<void> => {
      expect(await isLegacySafeApi(version)).to.equal(isLegacy);
    };

    const expectInvalidSafeApiVersion = async (
      version: unknown,
    ): Promise<void> => {
      try {
        await isLegacySafeApi(version);
        expect.fail('Expected isLegacySafeApi to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          `Invalid Safe API version: ${stringifyVersionForExpectation(version)}`,
        );
      }
    };

    it('detects legacy versions', async () => {
      await expectLegacyStatus('5.17.9', true);
    });

    it('accepts minimum version', async () => {
      await expectLegacyStatus('5.18.0', false);
    });

    it('accepts newer versions', async () => {
      await expectLegacyStatus('5.19.1', false);
    });

    it('supports semver prefixes/suffixes used by services', async () => {
      const nonLegacyVersions = [
        'v5.18.0',
        'V5.18.0',
        '9007199254740991.0.0',
        '5.18.0+L2',
        'V5.18.0+L2',
        '5.18.0+build.1',
        '5.18.9007199254740991',
        '5.18.0-rc.1',
        '5.18.0-rc.01a',
        '5.18.0-rc.1+L2',
        '5.18.0-rc.1+build.7',
        '5.18.0-0.3.7+exp.sha.5114f85',
        '  v5.18.1-build.11  ',
        '  V5.18.1-build.11  ',
      ];
      for (const version of nonLegacyVersions) {
        await expectLegacyStatus(version, false);
      }

      const legacyVersions = [
        'v5.17.9-hotfix.2',
        'v5.17.9-hotfix.2+meta.7',
        'V5.17.9-0.3.7+exp.sha.5114f85',
        'V5.17.9-hotfix.2',
      ];
      for (const version of legacyVersions) {
        await expectLegacyStatus(version, true);
      }
    });

    it('throws when version is missing', async () => {
      const missingVersions = [undefined, null, '', '   '];
      for (const version of missingVersions) {
        try {
          await isLegacySafeApi(version);
          expect.fail('Expected isLegacySafeApi to throw for missing version');
        } catch (error) {
          expect((error as Error).message).to.equal('Version is required');
        }
      }
    });

    it('throws on invalid versions', async () => {
      const invalidVersions = [
        'invalid',
        '5.18',
        '05.18.0',
        '5.018.0',
        '5.18.00',
        'v05.18.0',
        '5.18.0-01',
        '5.18.0-rc.01',
        '5.18.0foo',
        'V5.17.9foo',
        '5.18.0-',
        '5.18.0+',
        '5.18.0+L2_beta',
        '5.18.0-rc.1+',
        '5.18.0-+L2',
        '5.18.0-rc..1',
        '5.18.0+build..1',
        '5.18.0 +L2',
        '5.18.0-rc.1 +build.7',
        '9007199254740993.18.0',
        '5.9007199254740993.0',
        '5.18.9007199254740993',
      ];
      for (const version of invalidVersions) {
        await expectInvalidSafeApiVersion(version);
      }

      await expectInvalidSafeApiVersion(123);
      const unstringifiableVersion = {
        [Symbol.toPrimitive]: () => {
          throw new Error('boom');
        },
      };
      await expectInvalidSafeApiVersion(unstringifiableVersion);
    });
  });

  describe(resolveSafeSigner.name, () => {
    type SignerProvider = Parameters<typeof resolveSafeSigner>[1];

    it('returns explicit signer when provided', async () => {
      const explicitSigner = '0x1234567890123456789012345678901234567890';
      const multiProviderMock: SignerProvider = {
        getSigner: () => {
          throw new Error('should not be called');
        },
      };

      const signer = await resolveSafeSigner(
        'test',
        multiProviderMock,
        explicitSigner,
      );
      expect(signer).to.equal(explicitSigner);
    });

    it('canonicalizes explicit signer strings for address and private key', async () => {
      const explicitAddress = '0x52908400098527886e0f7030069857d2e4169ee7';
      const explicitPrivateKey = `0X${'AB'.repeat(32)}`;
      const explicitAddressWithWhitespace = `  ${explicitAddress}  `;
      const explicitPrivateKeyWithWhitespace = ` \n${explicitPrivateKey}\t`;
      const multiProviderMock: SignerProvider = {
        getSigner: () => {
          throw new Error('should not be called');
        },
      };

      const resolvedAddressSigner = await resolveSafeSigner(
        'test',
        multiProviderMock,
        explicitAddress,
      );
      expect(resolvedAddressSigner).to.equal(getAddress(explicitAddress));

      const resolvedPrivateKeySigner = await resolveSafeSigner(
        'test',
        multiProviderMock,
        explicitPrivateKey,
      );
      expect(resolvedPrivateKeySigner).to.equal(`0x${'ab'.repeat(32)}`);

      const resolvedWhitespaceAddressSigner = await resolveSafeSigner(
        'test',
        multiProviderMock,
        explicitAddressWithWhitespace,
      );
      expect(resolvedWhitespaceAddressSigner).to.equal(
        getAddress(explicitAddress),
      );

      const resolvedWhitespacePrivateKeySigner = await resolveSafeSigner(
        'test',
        multiProviderMock,
        explicitPrivateKeyWithWhitespace,
      );
      expect(resolvedWhitespacePrivateKeySigner).to.equal(
        `0x${'ab'.repeat(32)}`,
      );
    });

    it('throws when explicit signer string is not address or private key', async () => {
      const multiProviderMock: SignerProvider = {
        getSigner: () => {
          throw new Error('should not be called');
        },
      };

      try {
        await resolveSafeSigner('test', multiProviderMock, 'bad-signer');
        expect.fail('Expected resolveSafeSigner to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Explicit Safe signer string must be a valid address or 32-byte hex private key: bad-signer',
        );
      }
    });

    it('throws when explicit signer is invalid non-string primitive', async () => {
      const multiProviderMock: SignerProvider = {
        getSigner: () => {
          throw new Error('should not be called');
        },
      };

      try {
        await resolveSafeSigner(
          'test',
          multiProviderMock,
          123 as unknown as Parameters<typeof resolveSafeSigner>[2],
        );
        expect.fail('Expected resolveSafeSigner to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Explicit Safe signer must be a signer object, address, or 32-byte hex private key: 123',
        );
      }
    });

    it('prefers multiprovider private key when signer is not provided', async () => {
      const wallet = ethers.Wallet.createRandom();
      const multiProviderMock: SignerProvider = {
        getSigner: () => wallet,
      };

      const signer = await resolveSafeSigner('test', multiProviderMock);
      expect(signer).to.equal(wallet.privateKey.toLowerCase());
    });

    it('canonicalizes multiprovider private key casing', async () => {
      const uppercasePrivateKey = `0X${'AB'.repeat(32)}`;
      const multiProviderMock: SignerProvider = {
        getSigner: () =>
          ({
            privateKey: uppercasePrivateKey,
          }) as unknown as ethers.Signer,
      };

      const signer = await resolveSafeSigner('test', multiProviderMock);
      expect(signer).to.equal(`0x${'ab'.repeat(32)}`);
    });

    it('falls back to signer address when private key is unavailable', async () => {
      const signerAddress = '0x52908400098527886e0f7030069857d2e4169ee7';
      const multiProviderMock: SignerProvider = {
        getSigner: () => new ethers.VoidSigner(signerAddress),
      };

      const signer = await resolveSafeSigner('test', multiProviderMock);
      expect(signer).to.equal(getAddress(signerAddress));
    });

    it('throws when multiprovider signer lookup fails', async () => {
      const multiProviderMock: SignerProvider = {
        getSigner: () => {
          throw new Error('lookup failed');
        },
      };

      try {
        await resolveSafeSigner('test', multiProviderMock);
        expect.fail('Expected resolveSafeSigner to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Failed to resolve signer from MultiProvider on test: Error: lookup failed',
        );
      }
    });

    it('throws when multiprovider signer is not an object', async () => {
      const multiProviderMock: SignerProvider = {
        getSigner: () => 123 as unknown as ethers.Signer,
      };

      try {
        await resolveSafeSigner('test', multiProviderMock);
        expect.fail('Expected resolveSafeSigner to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Resolved MultiProvider signer must be an object: 123',
        );
      }
    });

    it('throws when private key accessor is inaccessible', async () => {
      const signerWithThrowingPrivateKey = {
        get privateKey() {
          throw new Error('boom');
        },
        getAddress: async () => '0x2222222222222222222222222222222222222222',
      };
      const multiProviderMock: SignerProvider = {
        getSigner: () =>
          signerWithThrowingPrivateKey as unknown as ethers.Signer,
      };

      try {
        await resolveSafeSigner('test', multiProviderMock);
        expect.fail('Expected resolveSafeSigner to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Resolved MultiProvider signer privateKey is inaccessible',
        );
      }
    });

    it('throws when private key is invalid', async () => {
      const multiProviderMock: SignerProvider = {
        getSigner: () =>
          ({
            privateKey: 123,
            getAddress: async () =>
              '0x2222222222222222222222222222222222222222',
          }) as unknown as ethers.Signer,
      };

      try {
        await resolveSafeSigner('test', multiProviderMock);
        expect.fail('Expected resolveSafeSigner to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Resolved MultiProvider private key must be a non-empty string: 123',
        );
      }

      const malformedPrivateKeyProvider: SignerProvider = {
        getSigner: () =>
          ({
            privateKey: 'not-hex',
          }) as unknown as ethers.Signer,
      };

      try {
        await resolveSafeSigner('test', malformedPrivateKeyProvider);
        expect.fail('Expected resolveSafeSigner to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Resolved MultiProvider private key must be 32-byte hex: not-hex',
        );
      }
    });

    it('throws when signer address resolver is missing, inaccessible, or invalid', async () => {
      const missingResolverProvider: SignerProvider = {
        getSigner: () =>
          ({ privateKey: undefined }) as unknown as ethers.Signer,
      };
      const inaccessibleResolverProvider: SignerProvider = {
        getSigner: () =>
          ({
            get getAddress() {
              throw new Error('boom');
            },
          }) as unknown as ethers.Signer,
      };
      const invalidAddressProvider: SignerProvider = {
        getSigner: () =>
          ({
            getAddress: async () => 'bad',
          }) as unknown as ethers.Signer,
      };

      try {
        await resolveSafeSigner('test', missingResolverProvider);
        expect.fail('Expected resolveSafeSigner to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Resolved MultiProvider signer getAddress must be a function: undefined',
        );
      }

      try {
        await resolveSafeSigner('test', inaccessibleResolverProvider);
        expect.fail('Expected resolveSafeSigner to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Resolved MultiProvider signer getAddress is inaccessible',
        );
      }

      try {
        await resolveSafeSigner('test', invalidAddressProvider);
        expect.fail('Expected resolveSafeSigner to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Resolved signer address must be valid: bad',
        );
      }
    });

    it('throws when signer address resolution call fails', async () => {
      const failingProvider: SignerProvider = {
        getSigner: () =>
          ({
            getAddress: async () => {
              throw new Error('address failure');
            },
          }) as unknown as ethers.Signer,
      };

      try {
        await resolveSafeSigner('test', failingProvider);
        expect.fail('Expected resolveSafeSigner to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Failed to resolve signer address from MultiProvider on test: Error: address failure',
        );
      }
    });
  });

  describe(hasSafeServiceTransactionPayload.name, () => {
    it('returns true when to/data/value are present', () => {
      expect(
        hasSafeServiceTransactionPayload({
          to: '0x00000000000000000000000000000000000000aa',
          data: '0x1234',
          value: '1',
        }),
      ).to.equal(true);
      expect(
        hasSafeServiceTransactionPayload({
          to: '0x00000000000000000000000000000000000000aa',
          data: '0x',
          value: '0',
        }),
      ).to.equal(true);
    });

    it('returns false when payload fields are missing', () => {
      expect(hasSafeServiceTransactionPayload(undefined)).to.equal(false);
      expect(hasSafeServiceTransactionPayload(null)).to.equal(false);
      expect(hasSafeServiceTransactionPayload(123)).to.equal(false);
      expect(
        hasSafeServiceTransactionPayload({
          to: '0x00000000000000000000000000000000000000aa',
          data: null,
          value: '1',
        }),
      ).to.equal(false);
      expect(
        hasSafeServiceTransactionPayload({
          to: '0x00000000000000000000000000000000000000aa',
          data: '0x1234',
          value: '',
        }),
      ).to.equal(false);
      expect(
        hasSafeServiceTransactionPayload({
          to: 'not-an-address',
          data: '0x1234',
          value: '1',
        }),
      ).to.equal(false);
      expect(
        hasSafeServiceTransactionPayload({
          to: '0x00000000000000000000000000000000000000aa',
          data: '1234',
          value: '1',
        }),
      ).to.equal(false);
      expect(
        hasSafeServiceTransactionPayload({
          to: '0x00000000000000000000000000000000000000aa',
          data: '0xzz',
          value: '1',
        }),
      ).to.equal(false);
      expect(
        hasSafeServiceTransactionPayload({
          to: '0x00000000000000000000000000000000000000aa',
          data: '0x1234',
          value: '1.0',
        }),
      ).to.equal(false);
      expect(
        hasSafeServiceTransactionPayload({
          to: '0x00000000000000000000000000000000000000aa',
          data: '0x1234',
          value: '-1',
        }),
      ).to.equal(false);
    });

    it('fails closed when payload access throws', () => {
      const throwingPayload = {
        get to() {
          throw new Error('boom');
        },
        data: '0x1234',
        value: '1',
      };
      expect(hasSafeServiceTransactionPayload(throwingPayload)).to.equal(false);
    });
  });

  describe(createSafeTransactionData.name, () => {
    it('normalizes calldata casing and missing 0x prefix', () => {
      const callData = createSafeTransactionData({
        to: '0x00000000000000000000000000000000000000aa',
        data: 'AbCd',
      });

      expect(callData.to).to.equal(
        getAddress('0x00000000000000000000000000000000000000aa'),
      );
      expect(callData.data).to.equal('0xabcd');
    });

    it('canonicalizes target address casing to checksum format', () => {
      const callData = createSafeTransactionData({
        to: '0x52908400098527886e0f7030069857d2e4169ee7',
        data: '0x1234',
      });

      expect(callData.to).to.equal(
        getAddress('0x52908400098527886e0f7030069857d2e4169ee7'),
      );
    });

    it('defaults value to zero when omitted', () => {
      const callData = createSafeTransactionData({
        to: '0x00000000000000000000000000000000000000aa',
        data: '0x1234',
      });

      expect(callData.value).to.equal('0');
    });

    it('serializes BigNumber-like values via toString', () => {
      const callData = createSafeTransactionData({
        to: '0x00000000000000000000000000000000000000aa',
        data: '0x1234',
        value: {
          toString: () => '42',
        },
      });

      expect(callData.value).to.equal('42');
    });

    it('serializes bigint values to decimal strings', () => {
      const callData = createSafeTransactionData({
        to: '0x00000000000000000000000000000000000000aa',
        data: '0x1234',
        value: 123n,
      });

      expect(callData.value).to.equal('123');
    });

    it('throws when call payload is non-object', () => {
      expect(() => createSafeTransactionData(null)).to.throw(
        'Safe call payload must be an object: null',
      );
      expect(() => createSafeTransactionData(123)).to.throw(
        'Safe call payload must be an object: 123',
      );
    });

    it('throws when call payload fields are inaccessible', () => {
      const inaccessiblePayload = {
        get to() {
          throw new Error('boom');
        },
      };
      expect(() => createSafeTransactionData(inaccessiblePayload)).to.throw(
        'Safe call payload fields are inaccessible',
      );
    });

    it('throws when target address is invalid', () => {
      expect(() =>
        createSafeTransactionData({
          to: '0x1234',
          data: '0x1234',
        }),
      ).to.throw('Safe call target must be valid address: 0x1234');
    });

    it('throws when calldata is missing or invalid', () => {
      expect(() =>
        createSafeTransactionData({
          to: '0x00000000000000000000000000000000000000aa',
        }),
      ).to.throw('Safe call data is required');

      expect(() =>
        createSafeTransactionData({
          to: '0x00000000000000000000000000000000000000aa',
          data: 123,
        }),
      ).to.throw('Safe call data must be hex');
    });

    it('throws deterministic error for unstringifiable call value', () => {
      const unstringifiableValue = {
        toString: () => {
          throw new Error('boom');
        },
      };

      expect(() =>
        createSafeTransactionData({
          to: '0x00000000000000000000000000000000000000aa',
          data: '0x1234',
          value: unstringifiableValue,
        }),
      ).to.throw('Safe call value must be serializable: <unstringifiable>');
    });

    it('throws when call value is not an unsigned integer string', () => {
      expect(() =>
        createSafeTransactionData({
          to: '0x00000000000000000000000000000000000000aa',
          data: '0x1234',
          value: -1,
        }),
      ).to.throw('Safe call value must be an unsigned integer string: -1');

      expect(() =>
        createSafeTransactionData({
          to: '0x00000000000000000000000000000000000000aa',
          data: '0x1234',
          value: '1.0',
        }),
      ).to.throw('Safe call value must be an unsigned integer string: 1.0');

      expect(() =>
        createSafeTransactionData({
          to: '0x00000000000000000000000000000000000000aa',
          data: '0x1234',
          value: true,
        }),
      ).to.throw('Safe call value must be an unsigned integer string: true');
    });
  });

  describe(createSafeTransaction.name, () => {
    const exampleTransactions = [
      {
        to: '0x00000000000000000000000000000000000000aa',
        data: '0x1234',
        value: '0',
      },
    ];

    it('forwards calls to Safe SDK createTransaction', async () => {
      const createTransactionCalls: unknown[] = [];
      const expectedSafeTx = { data: { nonce: 7 } } as unknown;
      const safeSdkMock = {
        createTransaction: async (args: unknown) => {
          createTransactionCalls.push(args);
          return expectedSafeTx;
        },
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      const result = await createSafeTransaction(
        safeSdkMock,
        exampleTransactions,
        true,
        7,
      );

      expect(result).to.equal(expectedSafeTx);
      expect(createTransactionCalls).to.deep.equal([
        {
          transactions: [
            {
              to: getAddress('0x00000000000000000000000000000000000000aa'),
              data: '0x1234',
              value: '0',
            },
          ],
          onlyCalls: true,
          options: { nonce: 7 },
        },
      ]);
    });

    it('omits nonce options when nonce is undefined', async () => {
      const createTransactionCalls: unknown[] = [];
      const safeSdkMock = {
        createTransaction: async (args: unknown) => {
          createTransactionCalls.push(args);
          return { data: { nonce: 0 } };
        },
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      await createSafeTransaction(safeSdkMock, exampleTransactions, false);

      expect(createTransactionCalls).to.deep.equal([
        {
          transactions: [
            {
              to: getAddress('0x00000000000000000000000000000000000000aa'),
              data: '0x1234',
              value: '0',
            },
          ],
          onlyCalls: false,
        },
      ]);
    });

    it('normalizes transaction entries before forwarding to safe sdk', async () => {
      const createTransactionCalls: unknown[] = [];
      const safeSdkMock = {
        createTransaction: async (args: unknown) => {
          createTransactionCalls.push(args);
          return { data: { nonce: 0 } };
        },
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      await createSafeTransaction(safeSdkMock, [
        {
          to: '0x52908400098527886e0f7030069857d2e4169ee7',
          data: 'ABCD',
        },
      ] as unknown as Parameters<typeof createSafeTransaction>[1]);

      expect(createTransactionCalls).to.deep.equal([
        {
          transactions: [
            {
              to: getAddress('0x52908400098527886e0f7030069857d2e4169ee7'),
              data: '0xabcd',
              value: '0',
            },
          ],
          onlyCalls: undefined,
        },
      ]);
    });

    it('throws when transaction list is non-array', async () => {
      const safeSdkMock = {
        createTransaction: async () => ({ data: { nonce: 1 } }),
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      try {
        await createSafeTransaction(
          safeSdkMock,
          123 as unknown as Parameters<typeof createSafeTransaction>[1],
        );
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction list must be an array: 123',
        );
      }
    });

    it('throws when transaction list is empty', async () => {
      const safeSdkMock = {
        createTransaction: async () => ({ data: { nonce: 1 } }),
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      try {
        await createSafeTransaction(safeSdkMock, []);
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction list must include at least one call',
        );
      }
    });

    it('throws when safe sdk instance is non-object', async () => {
      try {
        await createSafeTransaction(
          123 as unknown as Parameters<typeof createSafeTransaction>[0],
          exampleTransactions,
        );
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe SDK instance must be an object: 123',
        );
      }
    });

    it('throws when safe sdk createTransaction accessor is inaccessible', async () => {
      const safeSdkWithThrowingAccessor = {
        get createTransaction() {
          throw new Error('boom');
        },
      };

      try {
        await createSafeTransaction(
          safeSdkWithThrowingAccessor as unknown as Parameters<
            typeof createSafeTransaction
          >[0],
          exampleTransactions,
        );
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe SDK createTransaction accessor is inaccessible',
        );
      }
    });

    it('throws when safe sdk createTransaction is not a function', async () => {
      try {
        await createSafeTransaction(
          {
            createTransaction: 'bad',
          } as unknown as Parameters<typeof createSafeTransaction>[0],
          exampleTransactions,
        );
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe SDK createTransaction must be a function: bad',
        );
      }
    });

    it('throws when safe sdk createTransaction call fails', async () => {
      const safeSdkMock = {
        createTransaction: async () => {
          throw new Error('boom');
        },
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      try {
        await createSafeTransaction(safeSdkMock, exampleTransactions);
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Failed to create Safe transaction: Error: boom',
        );
      }
    });

    it('throws when safe sdk createTransaction returns non-object', async () => {
      const safeSdkMock = {
        createTransaction: async () => 123,
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      try {
        await createSafeTransaction(safeSdkMock, exampleTransactions);
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe SDK createTransaction must return an object: 123',
        );
      }
    });

    it('throws when safe sdk createTransaction payload fields are inaccessible', async () => {
      const safeSdkMock = {
        createTransaction: async () => ({
          get data() {
            throw new Error('boom');
          },
        }),
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      try {
        await createSafeTransaction(safeSdkMock, exampleTransactions);
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe SDK transaction payload fields are inaccessible',
        );
      }
    });

    it('throws when safe sdk createTransaction data is non-object', async () => {
      const safeSdkMock = {
        createTransaction: async () => ({ data: 'bad' }),
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      try {
        await createSafeTransaction(safeSdkMock, exampleTransactions);
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe SDK transaction data must be an object: bad',
        );
      }
    });

    it('throws when transaction list length access is inaccessible', async () => {
      const transactionsWithThrowingLength = new Proxy(exampleTransactions, {
        get(target, property, receiver) {
          if (property === 'length') {
            throw new Error('boom');
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const safeSdkMock = {
        createTransaction: async () => ({ data: { nonce: 1 } }),
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      try {
        await createSafeTransaction(
          safeSdkMock,
          transactionsWithThrowingLength as unknown as Parameters<
            typeof createSafeTransaction
          >[1],
        );
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction list length is inaccessible',
        );
      }
    });

    it('throws when transaction list length is invalid', async () => {
      const transactionsWithInvalidLength = new Proxy(exampleTransactions, {
        get(target, property, receiver) {
          if (property === 'length') {
            return Number.POSITIVE_INFINITY;
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const safeSdkMock = {
        createTransaction: async () => ({ data: { nonce: 1 } }),
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      try {
        await createSafeTransaction(
          safeSdkMock,
          transactionsWithInvalidLength as unknown as Parameters<
            typeof createSafeTransaction
          >[1],
        );
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction list length is invalid: Infinity',
        );
      }
    });

    it('throws when transaction list entry access is inaccessible', async () => {
      const transactionsWithThrowingEntry = [...exampleTransactions];
      Object.defineProperty(transactionsWithThrowingEntry, '0', {
        get() {
          throw new Error('boom');
        },
      });
      const safeSdkMock = {
        createTransaction: async () => ({ data: { nonce: 1 } }),
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      try {
        await createSafeTransaction(
          safeSdkMock,
          transactionsWithThrowingEntry as unknown as Parameters<
            typeof createSafeTransaction
          >[1],
        );
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction entry is inaccessible at index 0',
        );
      }
    });

    it('throws when transaction list entry is non-object', async () => {
      const safeSdkMock = {
        createTransaction: async () => ({ data: { nonce: 1 } }),
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      try {
        await createSafeTransaction(safeSdkMock, [123] as unknown as Parameters<
          typeof createSafeTransaction
        >[1]);
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction entry must be an object at index 0: 123',
        );
      }
    });

    it('throws when transaction list entry payload is invalid', async () => {
      const safeSdkMock = {
        createTransaction: async () => ({ data: { nonce: 1 } }),
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      try {
        await createSafeTransaction(safeSdkMock, [
          {
            to: 'bad',
            data: '0x1234',
            value: '0',
          },
        ] as unknown as Parameters<typeof createSafeTransaction>[1]);
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe call target must be valid address: bad',
        );
      }
    });

    it('throws when onlyCalls flag is not boolean', async () => {
      const safeSdkMock = {
        createTransaction: async () => ({ data: { nonce: 1 } }),
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      try {
        await createSafeTransaction(
          safeSdkMock,
          exampleTransactions,
          1 as unknown as Parameters<typeof createSafeTransaction>[2],
        );
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction onlyCalls flag must be a boolean: 1',
        );
      }
    });

    it('throws when nonce is not a non-negative safe integer', async () => {
      const safeSdkMock = {
        createTransaction: async () => ({ data: { nonce: 1 } }),
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      for (const invalidNonce of [
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        try {
          await createSafeTransaction(
            safeSdkMock,
            exampleTransactions,
            undefined,
            invalidNonce,
          );
          expect.fail('Expected createSafeTransaction to throw');
        } catch (error) {
          expect((error as Error).message).to.include(
            'Safe transaction nonce must be a non-negative safe integer:',
          );
        }
      }
    });

    it('accepts nonce boundaries at zero and max safe integer', async () => {
      const createTransactionCalls: unknown[] = [];
      const safeSdkMock = {
        createTransaction: async (args: unknown) => {
          createTransactionCalls.push(args);
          return { data: { nonce: 0 } };
        },
      } as unknown as Parameters<typeof createSafeTransaction>[0];
      const acceptedNonces = [0, Number.MAX_SAFE_INTEGER];

      for (const nonce of acceptedNonces) {
        await createSafeTransaction(
          safeSdkMock,
          exampleTransactions,
          undefined,
          nonce,
        );
      }

      expect(createTransactionCalls).to.deep.equal([
        {
          transactions: [
            {
              to: getAddress('0x00000000000000000000000000000000000000aa'),
              data: '0x1234',
              value: '0',
            },
          ],
          onlyCalls: undefined,
          options: { nonce: 0 },
        },
        {
          transactions: [
            {
              to: getAddress('0x00000000000000000000000000000000000000aa'),
              data: '0x1234',
              value: '0',
            },
          ],
          onlyCalls: undefined,
          options: { nonce: Number.MAX_SAFE_INTEGER },
        },
      ]);
    });

    it('fails fast before safe sdk call on invalid nonce', async () => {
      let createTransactionCallCount = 0;
      const safeSdkMock = {
        createTransaction: async () => {
          createTransactionCallCount += 1;
          return { data: { nonce: 1 } };
        },
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      try {
        await createSafeTransaction(safeSdkMock, exampleTransactions, true, -1);
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.include(
          'Safe transaction nonce must be a non-negative safe integer:',
        );
      }

      expect(createTransactionCallCount).to.equal(0);
    });

    it('fails fast before safe sdk call on invalid transaction list', async () => {
      let createTransactionCallCount = 0;
      const safeSdkMock = {
        createTransaction: async () => {
          createTransactionCallCount += 1;
          return { data: { nonce: 1 } };
        },
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      try {
        await createSafeTransaction(
          safeSdkMock,
          'bad' as unknown as Parameters<typeof createSafeTransaction>[1],
        );
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction list must be an array: bad',
        );
      }

      expect(createTransactionCallCount).to.equal(0);
    });

    it('fails fast before safe sdk call on empty transaction list', async () => {
      let createTransactionCallCount = 0;
      const safeSdkMock = {
        createTransaction: async () => {
          createTransactionCallCount += 1;
          return { data: { nonce: 1 } };
        },
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      try {
        await createSafeTransaction(safeSdkMock, []);
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction list must include at least one call',
        );
      }

      expect(createTransactionCallCount).to.equal(0);
    });

    it('fails fast before safe sdk call on invalid transaction entry', async () => {
      let createTransactionCallCount = 0;
      const safeSdkMock = {
        createTransaction: async () => {
          createTransactionCallCount += 1;
          return { data: { nonce: 1 } };
        },
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      try {
        await createSafeTransaction(safeSdkMock, [
          undefined,
        ] as unknown as Parameters<typeof createSafeTransaction>[1]);
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction entry must be an object at index 0: undefined',
        );
      }

      expect(createTransactionCallCount).to.equal(0);
    });

    it('fails fast before safe sdk call on invalid transaction entry payload', async () => {
      let createTransactionCallCount = 0;
      const safeSdkMock = {
        createTransaction: async () => {
          createTransactionCallCount += 1;
          return { data: { nonce: 1 } };
        },
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      try {
        await createSafeTransaction(safeSdkMock, [
          {
            to: '0x00000000000000000000000000000000000000aa',
            data: '0xzz',
          },
        ] as unknown as Parameters<typeof createSafeTransaction>[1]);
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal('Safe call data must be hex');
      }

      expect(createTransactionCallCount).to.equal(0);
    });

    it('fails fast before return when safe sdk returns invalid value', async () => {
      let createTransactionCallCount = 0;
      const safeSdkMock = {
        createTransaction: async () => {
          createTransactionCallCount += 1;
          return 123;
        },
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      try {
        await createSafeTransaction(safeSdkMock, exampleTransactions);
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe SDK createTransaction must return an object: 123',
        );
      }

      expect(createTransactionCallCount).to.equal(1);
    });

    it('fails fast before return when safe sdk returns invalid payload data', async () => {
      let createTransactionCallCount = 0;
      const safeSdkMock = {
        createTransaction: async () => {
          createTransactionCallCount += 1;
          return { data: 'bad' };
        },
      } as unknown as Parameters<typeof createSafeTransaction>[0];

      try {
        await createSafeTransaction(safeSdkMock, exampleTransactions);
        expect.fail('Expected createSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe SDK transaction data must be an object: bad',
        );
      }

      expect(createTransactionCallCount).to.equal(1);
    });
  });

  describe(proposeSafeTransaction.name, () => {
    const safeTxHash = `0x${'11'.repeat(32)}`;
    const safeAddress = '0x00000000000000000000000000000000000000aa';
    const senderAddress = '0x00000000000000000000000000000000000000bb';
    const safeTransactionMock = {
      data: { to: safeAddress, value: '0', data: '0x1234' },
    } as unknown as Parameters<typeof proposeSafeTransaction>[3];

    it('proposes transaction with Safe service payload', async () => {
      const proposedPayloads: unknown[] = [];
      const safeSdkMock = {
        getTransactionHash: async () => safeTxHash,
        signTypedData: async () => ({ data: '0xabcdef' }),
      } as unknown as Parameters<typeof proposeSafeTransaction>[1];
      const safeServiceMock = {
        proposeTransaction: async (payload: unknown) => {
          proposedPayloads.push(payload);
        },
      } as unknown as Parameters<typeof proposeSafeTransaction>[2];
      const signerMock = {
        getAddress: async () => senderAddress,
      } as unknown as Parameters<typeof proposeSafeTransaction>[5];

      await proposeSafeTransaction(
        'test',
        safeSdkMock,
        safeServiceMock,
        safeTransactionMock,
        safeAddress,
        signerMock,
      );

      expect(proposedPayloads).to.deep.equal([
        {
          safeAddress: getAddress(safeAddress),
          safeTransactionData: {
            to: getAddress(safeAddress),
            value: '0',
            data: '0x1234',
          },
          safeTxHash,
          senderAddress,
          senderSignature: '0xabcdef',
        },
      ]);
    });

    it('canonicalizes safe transaction hash casing before submission', async () => {
      const proposedPayloads: unknown[] = [];
      const upperSafeTxHash = `0X${'AA'.repeat(32)}`;
      const safeSdkMock = {
        getTransactionHash: async () => upperSafeTxHash,
        signTypedData: async () => ({ data: '0xabcdef' }),
      } as unknown as Parameters<typeof proposeSafeTransaction>[1];
      const safeServiceMock = {
        proposeTransaction: async (payload: unknown) => {
          proposedPayloads.push(payload);
        },
      } as unknown as Parameters<typeof proposeSafeTransaction>[2];
      const signerMock = {
        getAddress: async () => senderAddress,
      } as unknown as Parameters<typeof proposeSafeTransaction>[5];

      await proposeSafeTransaction(
        'test',
        safeSdkMock,
        safeServiceMock,
        safeTransactionMock,
        safeAddress,
        signerMock,
      );

      expect(proposedPayloads).to.deep.equal([
        {
          safeAddress: getAddress(safeAddress),
          safeTransactionData: {
            to: getAddress(safeAddress),
            value: '0',
            data: '0x1234',
          },
          safeTxHash: `0x${'aa'.repeat(32)}`,
          senderAddress,
          senderSignature: '0xabcdef',
        },
      ]);
    });

    it('canonicalizes safe proposal payload address casing', async () => {
      const proposedPayloads: unknown[] = [];
      const lowerSafeAddress = '0x52908400098527886e0f7030069857d2e4169ee7';
      const lowerSenderAddress = '0x8617e340b3d01fa5f11f306f4090fd50e238070d';
      const mixedCaseTransaction = {
        data: { to: lowerSafeAddress, value: '0', data: '0xABCD' },
      } as unknown as Parameters<typeof proposeSafeTransaction>[3];
      const safeSdkMock = {
        getTransactionHash: async () => safeTxHash,
        signTypedData: async () => ({ data: '0XABCDEF' }),
      } as unknown as Parameters<typeof proposeSafeTransaction>[1];
      const safeServiceMock = {
        proposeTransaction: async (payload: unknown) => {
          proposedPayloads.push(payload);
        },
      } as unknown as Parameters<typeof proposeSafeTransaction>[2];
      const signerMock = {
        getAddress: async () => lowerSenderAddress,
      } as unknown as Parameters<typeof proposeSafeTransaction>[5];

      await proposeSafeTransaction(
        'test',
        safeSdkMock,
        safeServiceMock,
        mixedCaseTransaction,
        lowerSafeAddress,
        signerMock,
      );

      expect(proposedPayloads).to.deep.equal([
        {
          safeAddress: getAddress(lowerSafeAddress),
          safeTransactionData: {
            to: getAddress(lowerSafeAddress),
            value: '0',
            data: '0xabcd',
          },
          safeTxHash,
          senderAddress: getAddress(lowerSenderAddress),
          senderSignature: '0xabcdef',
        },
      ]);
    });

    it('preserves non-core safe transaction payload fields when normalizing', async () => {
      const proposedPayloads: unknown[] = [];
      const safeSdkMock = {
        getTransactionHash: async () => safeTxHash,
        signTypedData: async () => ({ data: '0xabcdef' }),
      } as unknown as Parameters<typeof proposeSafeTransaction>[1];
      const safeServiceMock = {
        proposeTransaction: async (payload: unknown) => {
          proposedPayloads.push(payload);
        },
      } as unknown as Parameters<typeof proposeSafeTransaction>[2];
      const signerMock = {
        getAddress: async () => senderAddress,
      } as unknown as Parameters<typeof proposeSafeTransaction>[5];
      const safeTransactionWithExtras = {
        data: {
          to: safeAddress,
          value: '0',
          data: '0xABCD',
          operation: 1,
          safeTxGas: '12345',
          baseGas: '0',
          gasPrice: '0',
          gasToken: '0x0000000000000000000000000000000000000000',
          refundReceiver: '0x0000000000000000000000000000000000000000',
          nonce: 7,
        },
      } as unknown as Parameters<typeof proposeSafeTransaction>[3];

      await proposeSafeTransaction(
        'test',
        safeSdkMock,
        safeServiceMock,
        safeTransactionWithExtras,
        safeAddress,
        signerMock,
      );

      expect(proposedPayloads).to.deep.equal([
        {
          safeAddress: getAddress(safeAddress),
          safeTransactionData: {
            to: getAddress(safeAddress),
            value: '0',
            data: '0xabcd',
            operation: 1,
            safeTxGas: '12345',
            baseGas: '0',
            gasPrice: '0',
            gasToken: '0x0000000000000000000000000000000000000000',
            refundReceiver: '0x0000000000000000000000000000000000000000',
            nonce: 7,
          },
          safeTxHash,
          senderAddress,
          senderSignature: '0xabcdef',
        },
      ]);
    });

    it('throws when safe transaction hash is invalid', async () => {
      const safeSdkMock = {
        getTransactionHash: async () => 'bad-hash',
        signTypedData: async () => ({ data: '0xabcdef' }),
      } as unknown as Parameters<typeof proposeSafeTransaction>[1];
      const safeServiceMock = {
        proposeTransaction: async () => undefined,
      } as unknown as Parameters<typeof proposeSafeTransaction>[2];
      const signerMock = {
        getAddress: async () => senderAddress,
      } as unknown as Parameters<typeof proposeSafeTransaction>[5];

      try {
        await proposeSafeTransaction(
          'test',
          safeSdkMock,
          safeServiceMock,
          safeTransactionMock,
          safeAddress,
          signerMock,
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction hash must be 32-byte hex: bad-hash',
        );
      }
    });

    it('throws when safe signer signature data is inaccessible', async () => {
      const safeSdkMock = {
        getTransactionHash: async () => safeTxHash,
        signTypedData: async () => ({
          get data() {
            throw new Error('boom');
          },
        }),
      } as unknown as Parameters<typeof proposeSafeTransaction>[1];
      const safeServiceMock = {
        proposeTransaction: async () => undefined,
      } as unknown as Parameters<typeof proposeSafeTransaction>[2];
      const signerMock = {
        getAddress: async () => senderAddress,
      } as unknown as Parameters<typeof proposeSafeTransaction>[5];

      try {
        await proposeSafeTransaction(
          'test',
          safeSdkMock,
          safeServiceMock,
          safeTransactionMock,
          safeAddress,
          signerMock,
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe sender signature data is inaccessible',
        );
      }
    });

    it('throws with deterministic message when signer address resolution fails', async () => {
      const safeSdkMock = {
        getTransactionHash: async () => safeTxHash,
        signTypedData: async () => ({ data: '0xabcdef' }),
      } as unknown as Parameters<typeof proposeSafeTransaction>[1];
      const safeServiceMock = {
        proposeTransaction: async () => undefined,
      } as unknown as Parameters<typeof proposeSafeTransaction>[2];
      const signerMock = {
        getAddress: async () => {
          throw new Error('signer unavailable');
        },
      } as unknown as Parameters<typeof proposeSafeTransaction>[5];

      try {
        await proposeSafeTransaction(
          'test',
          safeSdkMock,
          safeServiceMock,
          safeTransactionMock,
          safeAddress,
          signerMock,
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Failed to resolve Safe signer address: Error: signer unavailable',
        );
      }
    });

    it('throws when safe address is invalid', async () => {
      const safeSdkMock = {
        getTransactionHash: async () => safeTxHash,
        signTypedData: async () => ({ data: '0xabcdef' }),
      } as unknown as Parameters<typeof proposeSafeTransaction>[1];
      const safeServiceMock = {
        proposeTransaction: async () => undefined,
      } as unknown as Parameters<typeof proposeSafeTransaction>[2];
      const signerMock = {
        getAddress: async () => senderAddress,
      } as unknown as Parameters<typeof proposeSafeTransaction>[5];

      try {
        await proposeSafeTransaction(
          'test',
          safeSdkMock,
          safeServiceMock,
          safeTransactionMock,
          'bad' as unknown as Parameters<typeof proposeSafeTransaction>[4],
          signerMock,
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe address must be valid: bad',
        );
      }
    });

    it('throws when safe sdk instance is non-object', async () => {
      const safeServiceMock = {
        proposeTransaction: async () => undefined,
      } as unknown as Parameters<typeof proposeSafeTransaction>[2];
      const signerMock = {
        getAddress: async () => senderAddress,
      } as unknown as Parameters<typeof proposeSafeTransaction>[5];

      try {
        await proposeSafeTransaction(
          'test',
          123 as unknown as Parameters<typeof proposeSafeTransaction>[1],
          safeServiceMock,
          safeTransactionMock,
          safeAddress,
          signerMock,
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe SDK instance must be an object: 123',
        );
      }
    });

    it('throws when safe sdk accessors are inaccessible', async () => {
      const safeSdkWithThrowingAccessors = {
        get getTransactionHash() {
          throw new Error('boom');
        },
      };
      const safeServiceMock = {
        proposeTransaction: async () => undefined,
      } as unknown as Parameters<typeof proposeSafeTransaction>[2];
      const signerMock = {
        getAddress: async () => senderAddress,
      } as unknown as Parameters<typeof proposeSafeTransaction>[5];

      try {
        await proposeSafeTransaction(
          'test',
          safeSdkWithThrowingAccessors as unknown as Parameters<
            typeof proposeSafeTransaction
          >[1],
          safeServiceMock,
          safeTransactionMock,
          safeAddress,
          signerMock,
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe SDK transaction hash/signature accessors are inaccessible',
        );
      }
    });

    it('throws when safe sdk methods are not functions', async () => {
      const safeServiceMock = {
        proposeTransaction: async () => undefined,
      } as unknown as Parameters<typeof proposeSafeTransaction>[2];
      const signerMock = {
        getAddress: async () => senderAddress,
      } as unknown as Parameters<typeof proposeSafeTransaction>[5];

      try {
        await proposeSafeTransaction(
          'test',
          {
            getTransactionHash: 'bad',
            signTypedData: async () => ({ data: '0xabcdef' }),
          } as unknown as Parameters<typeof proposeSafeTransaction>[1],
          safeServiceMock,
          safeTransactionMock,
          safeAddress,
          signerMock,
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe SDK getTransactionHash must be a function: bad',
        );
      }

      try {
        await proposeSafeTransaction(
          'test',
          {
            getTransactionHash: async () => safeTxHash,
            signTypedData: 'bad',
          } as unknown as Parameters<typeof proposeSafeTransaction>[1],
          safeServiceMock,
          safeTransactionMock,
          safeAddress,
          signerMock,
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe SDK signTypedData must be a function: bad',
        );
      }
    });

    it('throws when safe service instance is non-object', async () => {
      const safeSdkMock = {
        getTransactionHash: async () => safeTxHash,
        signTypedData: async () => ({ data: '0xabcdef' }),
      } as unknown as Parameters<typeof proposeSafeTransaction>[1];
      const signerMock = {
        getAddress: async () => senderAddress,
      } as unknown as Parameters<typeof proposeSafeTransaction>[5];

      try {
        await proposeSafeTransaction(
          'test',
          safeSdkMock,
          123 as unknown as Parameters<typeof proposeSafeTransaction>[2],
          safeTransactionMock,
          safeAddress,
          signerMock,
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe service instance must be an object: 123',
        );
      }
    });

    it('throws when safe service proposal accessor is inaccessible', async () => {
      const safeSdkMock = {
        getTransactionHash: async () => safeTxHash,
        signTypedData: async () => ({ data: '0xabcdef' }),
      } as unknown as Parameters<typeof proposeSafeTransaction>[1];
      const safeServiceWithThrowingAccessor = {
        get proposeTransaction() {
          throw new Error('boom');
        },
      };
      const signerMock = {
        getAddress: async () => senderAddress,
      } as unknown as Parameters<typeof proposeSafeTransaction>[5];

      try {
        await proposeSafeTransaction(
          'test',
          safeSdkMock,
          safeServiceWithThrowingAccessor as unknown as Parameters<
            typeof proposeSafeTransaction
          >[2],
          safeTransactionMock,
          safeAddress,
          signerMock,
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe service proposeTransaction accessor is inaccessible',
        );
      }
    });

    it('throws when safe service proposal method is non-function', async () => {
      const safeSdkMock = {
        getTransactionHash: async () => safeTxHash,
        signTypedData: async () => ({ data: '0xabcdef' }),
      } as unknown as Parameters<typeof proposeSafeTransaction>[1];
      const signerMock = {
        getAddress: async () => senderAddress,
      } as unknown as Parameters<typeof proposeSafeTransaction>[5];

      try {
        await proposeSafeTransaction(
          'test',
          safeSdkMock,
          {
            proposeTransaction: 'bad',
          } as unknown as Parameters<typeof proposeSafeTransaction>[2],
          safeTransactionMock,
          safeAddress,
          signerMock,
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe service proposeTransaction must be a function: bad',
        );
      }
    });

    it('throws when signer shape is invalid', async () => {
      const safeSdkMock = {
        getTransactionHash: async () => safeTxHash,
        signTypedData: async () => ({ data: '0xabcdef' }),
      } as unknown as Parameters<typeof proposeSafeTransaction>[1];
      const safeServiceMock = {
        proposeTransaction: async () => undefined,
      } as unknown as Parameters<typeof proposeSafeTransaction>[2];

      try {
        await proposeSafeTransaction(
          'test',
          safeSdkMock,
          safeServiceMock,
          safeTransactionMock,
          safeAddress,
          123 as unknown as Parameters<typeof proposeSafeTransaction>[5],
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe signer getAddress must be a function: 123',
        );
      }

      try {
        await proposeSafeTransaction(
          'test',
          safeSdkMock,
          safeServiceMock,
          safeTransactionMock,
          safeAddress,
          {
            get getAddress() {
              throw new Error('boom');
            },
          } as unknown as Parameters<typeof proposeSafeTransaction>[5],
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe signer getAddress accessor is inaccessible',
        );
      }
    });

    it('throws when safe transaction payload shape is invalid', async () => {
      const safeSdkMock = {
        getTransactionHash: async () => safeTxHash,
        signTypedData: async () => ({ data: '0xabcdef' }),
      } as unknown as Parameters<typeof proposeSafeTransaction>[1];
      const safeServiceMock = {
        proposeTransaction: async () => undefined,
      } as unknown as Parameters<typeof proposeSafeTransaction>[2];
      const signerMock = {
        getAddress: async () => senderAddress,
      } as unknown as Parameters<typeof proposeSafeTransaction>[5];

      try {
        await proposeSafeTransaction(
          'test',
          safeSdkMock,
          safeServiceMock,
          123 as unknown as Parameters<typeof proposeSafeTransaction>[3],
          safeAddress,
          signerMock,
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction payload must be an object: 123',
        );
      }

      try {
        await proposeSafeTransaction(
          'test',
          safeSdkMock,
          safeServiceMock,
          {
            data: 'bad',
          } as unknown as Parameters<typeof proposeSafeTransaction>[3],
          safeAddress,
          signerMock,
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction data must be an object: bad',
        );
      }
    });

    it('throws when safe transaction data payload fields are invalid', async () => {
      const safeSdkMock = {
        getTransactionHash: async () => safeTxHash,
        signTypedData: async () => ({ data: '0xabcdef' }),
      } as unknown as Parameters<typeof proposeSafeTransaction>[1];
      const safeServiceMock = {
        proposeTransaction: async () => undefined,
      } as unknown as Parameters<typeof proposeSafeTransaction>[2];
      const signerMock = {
        getAddress: async () => senderAddress,
      } as unknown as Parameters<typeof proposeSafeTransaction>[5];

      try {
        await proposeSafeTransaction(
          'test',
          safeSdkMock,
          safeServiceMock,
          {
            data: {
              to: 'bad',
              data: '0x1234',
              value: '0',
              toString: () => 'bad-payload',
            },
          } as unknown as Parameters<typeof proposeSafeTransaction>[3],
          safeAddress,
          signerMock,
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction data payload is invalid: bad-payload',
        );
      }
    });

    it('throws when safe transaction data is inaccessible', async () => {
      const safeSdkMock = {
        getTransactionHash: async () => safeTxHash,
        signTypedData: async () => ({ data: '0xabcdef' }),
      } as unknown as Parameters<typeof proposeSafeTransaction>[1];
      const safeServiceMock = {
        proposeTransaction: async () => undefined,
      } as unknown as Parameters<typeof proposeSafeTransaction>[2];
      const signerMock = {
        getAddress: async () => senderAddress,
      } as unknown as Parameters<typeof proposeSafeTransaction>[5];
      const inaccessibleSafeTransaction = {
        get data() {
          throw new Error('boom');
        },
      };

      try {
        await proposeSafeTransaction(
          'test',
          safeSdkMock,
          safeServiceMock,
          inaccessibleSafeTransaction as unknown as Parameters<
            typeof proposeSafeTransaction
          >[3],
          safeAddress,
          signerMock,
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction data is inaccessible',
        );
      }
    });

    it('throws when safe transaction data payload fields are inaccessible', async () => {
      const safeSdkMock = {
        getTransactionHash: async () => safeTxHash,
        signTypedData: async () => ({ data: '0xabcdef' }),
      } as unknown as Parameters<typeof proposeSafeTransaction>[1];
      const safeServiceMock = {
        proposeTransaction: async () => undefined,
      } as unknown as Parameters<typeof proposeSafeTransaction>[2];
      const signerMock = {
        getAddress: async () => senderAddress,
      } as unknown as Parameters<typeof proposeSafeTransaction>[5];
      const inaccessiblePayloadFieldSafeTransaction = {
        data: {
          to: safeAddress,
          data: '0x1234',
          value: '0',
          get operation() {
            throw new Error('boom');
          },
        },
      };

      try {
        await proposeSafeTransaction(
          'test',
          safeSdkMock,
          safeServiceMock,
          inaccessiblePayloadFieldSafeTransaction as unknown as Parameters<
            typeof proposeSafeTransaction
          >[3],
          safeAddress,
          signerMock,
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction data payload fields are inaccessible',
        );
      }
    });

    it('throws when safe sdk hash/signing calls fail', async () => {
      const safeServiceMock = {
        proposeTransaction: async () => undefined,
      } as unknown as Parameters<typeof proposeSafeTransaction>[2];
      const signerMock = {
        getAddress: async () => senderAddress,
      } as unknown as Parameters<typeof proposeSafeTransaction>[5];
      const hashFailingSafeSdk = {
        getTransactionHash: async () => {
          throw new Error('hash failed');
        },
        signTypedData: async () => ({ data: '0xabcdef' }),
      } as unknown as Parameters<typeof proposeSafeTransaction>[1];
      const signingFailingSafeSdk = {
        getTransactionHash: async () => safeTxHash,
        signTypedData: async () => {
          throw new Error('sign failed');
        },
      } as unknown as Parameters<typeof proposeSafeTransaction>[1];

      try {
        await proposeSafeTransaction(
          'test',
          hashFailingSafeSdk,
          safeServiceMock,
          safeTransactionMock,
          safeAddress,
          signerMock,
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Failed to derive Safe transaction hash: Error: hash failed',
        );
      }

      try {
        await proposeSafeTransaction(
          'test',
          signingFailingSafeSdk,
          safeServiceMock,
          safeTransactionMock,
          safeAddress,
          signerMock,
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Failed to sign Safe transaction: Error: sign failed',
        );
      }
    });

    it('throws when signature data or signer address is invalid', async () => {
      const safeServiceMock = {
        proposeTransaction: async () => undefined,
      } as unknown as Parameters<typeof proposeSafeTransaction>[2];

      try {
        await proposeSafeTransaction(
          'test',
          {
            getTransactionHash: async () => safeTxHash,
            signTypedData: async () => ({ data: '' }),
          } as unknown as Parameters<typeof proposeSafeTransaction>[1],
          safeServiceMock,
          safeTransactionMock,
          safeAddress,
          {
            getAddress: async () => senderAddress,
          } as unknown as Parameters<typeof proposeSafeTransaction>[5],
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe sender signature data must be a non-empty string: ',
        );
      }

      try {
        await proposeSafeTransaction(
          'test',
          {
            getTransactionHash: async () => safeTxHash,
            signTypedData: async () => ({ data: '   ' }),
          } as unknown as Parameters<typeof proposeSafeTransaction>[1],
          safeServiceMock,
          safeTransactionMock,
          safeAddress,
          {
            getAddress: async () => senderAddress,
          } as unknown as Parameters<typeof proposeSafeTransaction>[5],
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe sender signature data must be a non-empty string:    ',
        );
      }

      try {
        await proposeSafeTransaction(
          'test',
          {
            getTransactionHash: async () => safeTxHash,
            signTypedData: async () => ({ data: 'not-hex' }),
          } as unknown as Parameters<typeof proposeSafeTransaction>[1],
          safeServiceMock,
          safeTransactionMock,
          safeAddress,
          {
            getAddress: async () => senderAddress,
          } as unknown as Parameters<typeof proposeSafeTransaction>[5],
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe sender signature data must be hex: not-hex',
        );
      }

      try {
        await proposeSafeTransaction(
          'test',
          {
            getTransactionHash: async () => safeTxHash,
            signTypedData: async () => ({ data: '0xabcdef' }),
          } as unknown as Parameters<typeof proposeSafeTransaction>[1],
          safeServiceMock,
          safeTransactionMock,
          safeAddress,
          {
            getAddress: async () => 'bad',
          } as unknown as Parameters<typeof proposeSafeTransaction>[5],
        );
        expect.fail('Expected proposeSafeTransaction to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe signer address must be valid: bad',
        );
      }
    });
  });

  describe('safe tx service helpers', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('getSafeTx throws for invalid safe tx hash before network call', async () => {
      let fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        throw new Error('fetch should not be called');
      }) as typeof fetch;

      const multiProviderMock = {
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof getSafeTx>[1];

      try {
        await getSafeTx('test', multiProviderMock, 'not-hex');
        expect.fail('Expected getSafeTx to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction hash must be 32-byte hex: not-hex',
        );
      }

      expect(fetchCalled).to.equal(false);
    });

    it('getSafeTx canonicalizes hash casing in tx-service request URL', async () => {
      const mixedCaseHash = `0X${'AB'.repeat(32)}`;
      const normalizedHash = `0x${'ab'.repeat(32)}`;
      let requestedUrl: string | undefined;

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        requestedUrl = typeof input === 'string' ? input : input.toString();
        return {
          ok: true,
          status: 200,
          json: async () => ({ safeTxHash: normalizedHash }),
        } as unknown as Response;
      }) as typeof fetch;

      const multiProviderMock = {
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof getSafeTx>[1];

      const transaction = await getSafeTx(
        'test',
        multiProviderMock,
        mixedCaseHash,
      );

      expect(requestedUrl).to.equal(
        `https://safe-transaction-mainnet.safe.global/api/v2/multisig-transactions/${normalizedHash}/`,
      );
      expect(transaction?.safeTxHash).to.equal(normalizedHash);
    });

    it('getSafeTx returns undefined when tx details payload is non-object', async () => {
      let fetchCalls = 0;
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => null,
        } as unknown as Response;
      }) as typeof fetch;

      const multiProviderMock = {
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof getSafeTx>[1];

      const transaction = await getSafeTx(
        'test',
        multiProviderMock,
        `0x${'ab'.repeat(32)}`,
      );
      expect(transaction).to.equal(undefined);
      expect(fetchCalls).to.equal(1);
    });

    it('getSafeTx returns undefined when tx details json parsing fails', async () => {
      let fetchCalls = 0;
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('bad json');
          },
        } as unknown as Response;
      }) as typeof fetch;

      const multiProviderMock = {
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof getSafeTx>[1];

      const transaction = await getSafeTx(
        'test',
        multiProviderMock,
        `0x${'ac'.repeat(32)}`,
      );

      expect(transaction).to.equal(undefined);
      expect(fetchCalls).to.equal(1);
    });

    it('deleteSafeTx throws for invalid safe tx hash before signer/network calls', async () => {
      let fetchCalled = false;
      let getSignerCalled = false;

      globalThis.fetch = (async () => {
        fetchCalled = true;
        throw new Error('fetch should not be called');
      }) as typeof fetch;

      const multiProviderMock = {
        getSigner: () => {
          getSignerCalled = true;
          throw new Error('getSigner should not be called');
        },
        getEvmChainId: () => 1,
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof deleteSafeTx>[1];

      try {
        await deleteSafeTx(
          'test',
          multiProviderMock,
          '0x0000000000000000000000000000000000000001',
          'bad-hash',
        );
        expect.fail('Expected deleteSafeTx to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction hash must be 32-byte hex: bad-hash',
        );
      }

      expect(getSignerCalled).to.equal(false);
      expect(fetchCalled).to.equal(false);
    });

    it('deleteSafeTx throws when deletion signer is non-object', async () => {
      globalThis.fetch = (async () => {
        throw new Error('fetch should not be called');
      }) as typeof fetch;

      const multiProviderMock = {
        getSigner: () => 123,
        getEvmChainId: () => 1,
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof deleteSafeTx>[1];

      try {
        await deleteSafeTx(
          'test',
          multiProviderMock,
          '0x0000000000000000000000000000000000000001',
          `0x${'11'.repeat(32)}`,
        );
        expect.fail('Expected deleteSafeTx to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe deletion signer must be an object: 123',
        );
      }
    });

    it('deleteSafeTx throws when deletion signer getAddress is not a function', async () => {
      globalThis.fetch = (async () => {
        throw new Error('fetch should not be called');
      }) as typeof fetch;

      const multiProviderMock = {
        getSigner: () => ({ getAddress: 123 }),
        getEvmChainId: () => 1,
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof deleteSafeTx>[1];

      try {
        await deleteSafeTx(
          'test',
          multiProviderMock,
          '0x0000000000000000000000000000000000000001',
          `0x${'12'.repeat(32)}`,
        );
        expect.fail('Expected deleteSafeTx to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe deletion signer getAddress must be a function: 123',
        );
      }
    });

    it('deleteSafeTx throws when deletion signer getAddress accessor is inaccessible', async () => {
      globalThis.fetch = (async () => {
        throw new Error('fetch should not be called');
      }) as typeof fetch;

      const signerWithThrowingAccessor = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === 'getAddress') {
              throw new Error('no accessor');
            }
            return undefined;
          },
        },
      );

      const multiProviderMock = {
        getSigner: () => signerWithThrowingAccessor,
        getEvmChainId: () => 1,
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof deleteSafeTx>[1];

      try {
        await deleteSafeTx(
          'test',
          multiProviderMock,
          '0x0000000000000000000000000000000000000001',
          `0x${'13'.repeat(32)}`,
        );
        expect.fail('Expected deleteSafeTx to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe deletion signer getAddress accessor is inaccessible',
        );
      }
    });

    it('deleteSafeTx throws when tx details payload is non-object', async () => {
      let signTypedDataCalled = false;
      const signerMock = {
        getAddress: async () => '0x00000000000000000000000000000000000000AA',
        _signTypedData: async () => {
          signTypedDataCalled = true;
          return `0x${'11'.repeat(65)}`;
        },
      };

      globalThis.fetch = (async () => {
        return {
          ok: true,
          status: 200,
          json: async () => null,
        } as unknown as Response;
      }) as typeof fetch;

      const multiProviderMock = {
        getSigner: () => signerMock,
        getEvmChainId: () => 1,
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof deleteSafeTx>[1];

      try {
        await deleteSafeTx(
          'test',
          multiProviderMock,
          '0x0000000000000000000000000000000000000001',
          `0x${'22'.repeat(32)}`,
        );
        expect.fail('Expected deleteSafeTx to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction details payload must be an object: null',
        );
      }
      expect(signTypedDataCalled).to.equal(false);
    });

    it('deleteSafeTx throws when tx details payload is inaccessible', async () => {
      let signTypedDataCalled = false;
      const signerMock = {
        getAddress: async () => '0x00000000000000000000000000000000000000AA',
        _signTypedData: async () => {
          signTypedDataCalled = true;
          return `0x${'11'.repeat(65)}`;
        },
      };

      globalThis.fetch = (async () => {
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('payload unavailable');
          },
        } as unknown as Response;
      }) as typeof fetch;

      const multiProviderMock = {
        getSigner: () => signerMock,
        getEvmChainId: () => 1,
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof deleteSafeTx>[1];

      try {
        await deleteSafeTx(
          'test',
          multiProviderMock,
          '0x0000000000000000000000000000000000000001',
          `0x${'23'.repeat(32)}`,
        );
        expect.fail('Expected deleteSafeTx to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction details payload is inaccessible',
        );
      }
      expect(signTypedDataCalled).to.equal(false);
    });

    it('deleteSafeTx throws when deletion signer address resolution fails', async () => {
      let signTypedDataCalled = false;
      const signerMock = {
        getAddress: async () => {
          throw new Error('boom');
        },
        _signTypedData: async () => {
          signTypedDataCalled = true;
          return `0x${'11'.repeat(65)}`;
        },
      };

      globalThis.fetch = (async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            proposer: '0x00000000000000000000000000000000000000AA',
          }),
        } as unknown as Response;
      }) as typeof fetch;

      const multiProviderMock = {
        getSigner: () => signerMock,
        getEvmChainId: () => 1,
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof deleteSafeTx>[1];

      try {
        await deleteSafeTx(
          'test',
          multiProviderMock,
          '0x0000000000000000000000000000000000000001',
          `0x${'44'.repeat(32)}`,
        );
        expect.fail('Expected deleteSafeTx to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Failed to resolve Safe deletion signer address: Error: boom',
        );
      }
      expect(signTypedDataCalled).to.equal(false);
    });

    it('deleteSafeTx throws when deletion signer address is invalid', async () => {
      let signTypedDataCalled = false;
      const signerMock = {
        getAddress: async () => 'bad',
        _signTypedData: async () => {
          signTypedDataCalled = true;
          return `0x${'11'.repeat(65)}`;
        },
      };

      globalThis.fetch = (async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            proposer: '0x00000000000000000000000000000000000000AA',
          }),
        } as unknown as Response;
      }) as typeof fetch;

      const multiProviderMock = {
        getSigner: () => signerMock,
        getEvmChainId: () => 1,
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof deleteSafeTx>[1];

      try {
        await deleteSafeTx(
          'test',
          multiProviderMock,
          '0x0000000000000000000000000000000000000001',
          `0x${'55'.repeat(32)}`,
        );
        expect.fail('Expected deleteSafeTx to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe deletion signer address must be valid: bad',
        );
      }
      expect(signTypedDataCalled).to.equal(false);
    });

    it('deleteSafeTx throws when tx proposer is invalid', async () => {
      let signTypedDataCalled = false;
      const signerMock = {
        getAddress: async () => '0x00000000000000000000000000000000000000AA',
        _signTypedData: async () => {
          signTypedDataCalled = true;
          return `0x${'11'.repeat(65)}`;
        },
      };

      globalThis.fetch = (async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({ proposer: 'bad' }),
        } as unknown as Response;
      }) as typeof fetch;

      const multiProviderMock = {
        getSigner: () => signerMock,
        getEvmChainId: () => 1,
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof deleteSafeTx>[1];

      try {
        await deleteSafeTx(
          'test',
          multiProviderMock,
          '0x0000000000000000000000000000000000000001',
          `0x${'33'.repeat(32)}`,
        );
        expect.fail('Expected deleteSafeTx to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction proposer must be valid address: bad',
        );
      }
      expect(signTypedDataCalled).to.equal(false);
    });

    it('deleteSafeTx throws when tx proposer accessor is inaccessible', async () => {
      let signTypedDataCalled = false;
      const signerMock = {
        getAddress: async () => '0x00000000000000000000000000000000000000AA',
        _signTypedData: async () => {
          signTypedDataCalled = true;
          return `0x${'11'.repeat(65)}`;
        },
      };
      const txDetailsWithThrowingProposer = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === 'proposer') {
              throw new Error('hidden proposer');
            }
            return undefined;
          },
        },
      );

      globalThis.fetch = (async () => {
        return {
          ok: true,
          status: 200,
          json: async () => txDetailsWithThrowingProposer,
        } as unknown as Response;
      }) as typeof fetch;

      const multiProviderMock = {
        getSigner: () => signerMock,
        getEvmChainId: () => 1,
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof deleteSafeTx>[1];

      try {
        await deleteSafeTx(
          'test',
          multiProviderMock,
          '0x0000000000000000000000000000000000000001',
          `0x${'34'.repeat(32)}`,
        );
        expect.fail('Expected deleteSafeTx to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe transaction proposer is inaccessible',
        );
      }
      expect(signTypedDataCalled).to.equal(false);
    });

    it('deleteSafeTx skips delete request when signer _signTypedData accessor is inaccessible', async () => {
      const proposerAddress = '0x00000000000000000000000000000000000000AA';
      const requestUrls: string[] = [];
      const signerWithThrowingTypedDataAccessor = new Proxy(
        {
          getAddress: async () => proposerAddress,
        },
        {
          get(target, prop, receiver) {
            if (prop === '_signTypedData') {
              throw new Error('typed data accessor unavailable');
            }
            return Reflect.get(target, prop, receiver);
          },
        },
      );

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        requestUrls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ proposer: proposerAddress.toLowerCase() }),
        } as unknown as Response;
      }) as typeof fetch;

      const multiProviderMock = {
        getSigner: () => signerWithThrowingTypedDataAccessor,
        getEvmChainId: () => 1,
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof deleteSafeTx>[1];

      await deleteSafeTx(
        'test',
        multiProviderMock,
        '0x0000000000000000000000000000000000000001',
        `0x${'66'.repeat(32)}`,
      );

      expect(requestUrls).to.deep.equal([
        `https://safe-transaction-mainnet.safe.global/api/v2/multisig-transactions/0x${'66'.repeat(32)}/`,
      ]);
    });

    it('deleteSafeTx canonicalizes hash/address in signed payload and delete request', async () => {
      const mixedCaseSafeAddress = '0x52908400098527886e0f7030069857d2e4169ee7';
      const normalizedSafeAddress = getAddress(mixedCaseSafeAddress);
      const proposerAddress = '0x00000000000000000000000000000000000000AA';
      const mixedCaseHash = `0X${'CD'.repeat(32)}`;
      const normalizedHash = `0x${'cd'.repeat(32)}`;
      let typedDataDomain: Record<string, unknown> | undefined;
      let typedDataMessage: Record<string, unknown> | undefined;
      let getUrl: string | undefined;
      let deleteUrl: string | undefined;
      let deleteBody: string | undefined;
      let requestCount = 0;

      const signerMock = {
        getAddress: async () => proposerAddress,
        _signTypedData: async (
          domain: Record<string, unknown>,
          _types: Record<string, unknown>,
          message: Record<string, unknown>,
        ) => {
          typedDataDomain = domain;
          typedDataMessage = message;
          return `0x${'11'.repeat(65)}`;
        },
      };

      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        requestCount += 1;
        const url = typeof input === 'string' ? input : input.toString();
        if (requestCount === 1) {
          getUrl = url;
          return {
            ok: true,
            status: 200,
            json: async () => ({ proposer: proposerAddress.toLowerCase() }),
          } as unknown as Response;
        }
        deleteUrl = url;
        deleteBody = init?.body as string | undefined;
        return {
          status: 204,
          statusText: 'No Content',
          text: async () => '',
        } as unknown as Response;
      }) as typeof fetch;

      const multiProviderMock = {
        getSigner: () => signerMock,
        getEvmChainId: () => 1,
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof deleteSafeTx>[1];

      await deleteSafeTx(
        'test',
        multiProviderMock,
        mixedCaseSafeAddress,
        mixedCaseHash,
      );

      expect(getUrl).to.equal(
        `https://safe-transaction-mainnet.safe.global/api/v2/multisig-transactions/${normalizedHash}/`,
      );
      expect(deleteUrl).to.equal(
        `https://safe-transaction-mainnet.safe.global/api/v2/multisig-transactions/${normalizedHash}/`,
      );
      expect(typedDataDomain?.verifyingContract).to.equal(
        normalizedSafeAddress,
      );
      expect(typedDataMessage?.safeTxHash).to.equal(normalizedHash);
      expect(deleteBody).to.equal(
        JSON.stringify({
          safeTxHash: normalizedHash,
          signature: `0x${'11'.repeat(65)}`,
        }),
      );
    });

    it('deleteAllPendingSafeTxs throws for invalid safe address before metadata/network calls', async () => {
      let fetchCalled = false;
      let getChainMetadataCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        throw new Error('fetch should not be called');
      }) as typeof fetch;

      const multiProviderMock = {
        getChainMetadata: () => {
          getChainMetadataCalled = true;
          return {
            gnosisSafeTransactionServiceUrl:
              'https://safe-transaction-mainnet.safe.global/api',
          };
        },
      } as unknown as Parameters<typeof deleteAllPendingSafeTxs>[1];

      try {
        await deleteAllPendingSafeTxs(
          'test',
          multiProviderMock,
          'bad' as unknown as Parameters<typeof deleteAllPendingSafeTxs>[2],
        );
        expect.fail('Expected deleteAllPendingSafeTxs to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Safe address must be valid: bad',
        );
      }

      expect(getChainMetadataCalled).to.equal(false);
      expect(fetchCalled).to.equal(false);
    });

    it('deleteAllPendingSafeTxs canonicalizes safe address and continues on invalid pending hashes', async () => {
      const mixedCaseSafeAddress = '0x52908400098527886e0f7030069857d2e4169ee7';
      const normalizedSafeAddress = getAddress(mixedCaseSafeAddress);
      const mixedCaseHash = `0X${'AA'.repeat(32)}`;
      const normalizedHash = `0x${'aa'.repeat(32)}`;
      const proposerAddress = '0x00000000000000000000000000000000000000AA';
      let typedDataDomain: Record<string, unknown> | undefined;
      let typedDataMessage: Record<string, unknown> | undefined;
      let deleteBody: string | undefined;
      const requestUrls: string[] = [];

      const signerMock = {
        getAddress: async () => proposerAddress,
        _signTypedData: async (
          domain: Record<string, unknown>,
          _types: Record<string, unknown>,
          message: Record<string, unknown>,
        ) => {
          typedDataDomain = domain;
          typedDataMessage = message;
          return `0x${'22'.repeat(65)}`;
        },
      };

      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url = typeof input === 'string' ? input : input.toString();
        requestUrls.push(url);
        if (requestUrls.length === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              results: [
                { safeTxHash: 'bad-hash' },
                { safeTxHash: mixedCaseHash },
              ],
            }),
          } as unknown as Response;
        }
        if (requestUrls.length === 2) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ proposer: proposerAddress.toLowerCase() }),
          } as unknown as Response;
        }
        deleteBody = init?.body as string | undefined;
        return {
          status: 204,
          statusText: 'No Content',
          text: async () => '',
        } as unknown as Response;
      }) as typeof fetch;

      const multiProviderMock = {
        getSigner: () => signerMock,
        getEvmChainId: () => 1,
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof deleteAllPendingSafeTxs>[1];

      await deleteAllPendingSafeTxs(
        'test',
        multiProviderMock,
        mixedCaseSafeAddress as Parameters<typeof deleteAllPendingSafeTxs>[2],
      );

      expect(requestUrls).to.deep.equal([
        `https://safe-transaction-mainnet.safe.global/api/v2/safes/${normalizedSafeAddress}/multisig-transactions/?executed=false&limit=100`,
        `https://safe-transaction-mainnet.safe.global/api/v2/multisig-transactions/${normalizedHash}/`,
        `https://safe-transaction-mainnet.safe.global/api/v2/multisig-transactions/${normalizedHash}/`,
      ]);
      expect(typedDataDomain?.verifyingContract).to.equal(
        normalizedSafeAddress,
      );
      expect(typedDataMessage?.safeTxHash).to.equal(normalizedHash);
      expect(deleteBody).to.equal(
        JSON.stringify({
          safeTxHash: normalizedHash,
          signature: `0x${'22'.repeat(65)}`,
        }),
      );
    });

    it('deleteAllPendingSafeTxs continues on malformed pending entries and inaccessible hashes', async () => {
      const safeAddress = '0x52908400098527886e0f7030069857d2e4169ee7';
      const normalizedSafeAddress = getAddress(safeAddress);
      const mixedCaseHash = `0X${'BB'.repeat(32)}`;
      const normalizedHash = `0x${'bb'.repeat(32)}`;
      const proposerAddress = '0x00000000000000000000000000000000000000AA';
      let typedDataDomain: Record<string, unknown> | undefined;
      let typedDataMessage: Record<string, unknown> | undefined;
      let deleteBody: string | undefined;
      const requestUrls: string[] = [];

      const signerMock = {
        getAddress: async () => proposerAddress,
        _signTypedData: async (
          domain: Record<string, unknown>,
          _types: Record<string, unknown>,
          message: Record<string, unknown>,
        ) => {
          typedDataDomain = domain;
          typedDataMessage = message;
          return `0x${'33'.repeat(65)}`;
        },
      };
      const entryWithThrowingHash = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === 'safeTxHash') {
              throw new Error('hidden hash');
            }
            return undefined;
          },
        },
      );

      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url = typeof input === 'string' ? input : input.toString();
        requestUrls.push(url);
        if (requestUrls.length === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              results: [
                123,
                entryWithThrowingHash,
                { safeTxHash: 456 },
                { safeTxHash: mixedCaseHash },
              ],
            }),
          } as unknown as Response;
        }
        if (requestUrls.length === 2) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ proposer: proposerAddress.toLowerCase() }),
          } as unknown as Response;
        }
        deleteBody = init?.body as string | undefined;
        return {
          status: 204,
          statusText: 'No Content',
          text: async () => '',
        } as unknown as Response;
      }) as typeof fetch;

      const multiProviderMock = {
        getSigner: () => signerMock,
        getEvmChainId: () => 1,
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof deleteAllPendingSafeTxs>[1];

      await deleteAllPendingSafeTxs(
        'test',
        multiProviderMock,
        safeAddress as Parameters<typeof deleteAllPendingSafeTxs>[2],
      );

      expect(requestUrls).to.deep.equal([
        `https://safe-transaction-mainnet.safe.global/api/v2/safes/${normalizedSafeAddress}/multisig-transactions/?executed=false&limit=100`,
        `https://safe-transaction-mainnet.safe.global/api/v2/multisig-transactions/${normalizedHash}/`,
        `https://safe-transaction-mainnet.safe.global/api/v2/multisig-transactions/${normalizedHash}/`,
      ]);
      expect(typedDataDomain?.verifyingContract).to.equal(
        normalizedSafeAddress,
      );
      expect(typedDataMessage?.safeTxHash).to.equal(normalizedHash);
      expect(deleteBody).to.equal(
        JSON.stringify({
          safeTxHash: normalizedHash,
          signature: `0x${'33'.repeat(65)}`,
        }),
      );
    });

    it('deleteAllPendingSafeTxs continues when pending entry index access throws', async () => {
      const safeAddress = '0x52908400098527886e0f7030069857d2e4169ee7';
      const normalizedSafeAddress = getAddress(safeAddress);
      const mixedCaseHash = `0X${'CC'.repeat(32)}`;
      const normalizedHash = `0x${'cc'.repeat(32)}`;
      const proposerAddress = '0x00000000000000000000000000000000000000AA';
      let typedDataDomain: Record<string, unknown> | undefined;
      let typedDataMessage: Record<string, unknown> | undefined;
      let deleteBody: string | undefined;
      const requestUrls: string[] = [];

      const signerMock = {
        getAddress: async () => proposerAddress,
        _signTypedData: async (
          domain: Record<string, unknown>,
          _types: Record<string, unknown>,
          message: Record<string, unknown>,
        ) => {
          typedDataDomain = domain;
          typedDataMessage = message;
          return `0x${'44'.repeat(65)}`;
        },
      };
      const throwingIndexResults = new Proxy(
        [{ safeTxHash: mixedCaseHash }, { safeTxHash: mixedCaseHash }],
        {
          get(target, prop, receiver) {
            if (prop === '0') {
              throw new Error('index unavailable');
            }
            return Reflect.get(target, prop, receiver);
          },
        },
      );

      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url = typeof input === 'string' ? input : input.toString();
        requestUrls.push(url);
        if (requestUrls.length === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ results: throwingIndexResults }),
          } as unknown as Response;
        }
        if (requestUrls.length === 2) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ proposer: proposerAddress.toLowerCase() }),
          } as unknown as Response;
        }
        deleteBody = init?.body as string | undefined;
        return {
          status: 204,
          statusText: 'No Content',
          text: async () => '',
        } as unknown as Response;
      }) as typeof fetch;

      const multiProviderMock = {
        getSigner: () => signerMock,
        getEvmChainId: () => 1,
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof deleteAllPendingSafeTxs>[1];

      await deleteAllPendingSafeTxs(
        'test',
        multiProviderMock,
        safeAddress as Parameters<typeof deleteAllPendingSafeTxs>[2],
      );

      expect(requestUrls).to.deep.equal([
        `https://safe-transaction-mainnet.safe.global/api/v2/safes/${normalizedSafeAddress}/multisig-transactions/?executed=false&limit=100`,
        `https://safe-transaction-mainnet.safe.global/api/v2/multisig-transactions/${normalizedHash}/`,
        `https://safe-transaction-mainnet.safe.global/api/v2/multisig-transactions/${normalizedHash}/`,
      ]);
      expect(typedDataDomain?.verifyingContract).to.equal(
        normalizedSafeAddress,
      );
      expect(typedDataMessage?.safeTxHash).to.equal(normalizedHash);
      expect(deleteBody).to.equal(
        JSON.stringify({
          safeTxHash: normalizedHash,
          signature: `0x${'44'.repeat(65)}`,
        }),
      );
    });

    it('deleteAllPendingSafeTxs throws when pending tx list payload is invalid', async () => {
      globalThis.fetch = (async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({ results: 'not-array' }),
        } as unknown as Response;
      }) as typeof fetch;

      const multiProviderMock = {
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof deleteAllPendingSafeTxs>[1];

      try {
        await deleteAllPendingSafeTxs(
          'test',
          multiProviderMock,
          '0x0000000000000000000000000000000000000001',
        );
        expect.fail('Expected deleteAllPendingSafeTxs to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Pending Safe transactions list must be an array: not-array',
        );
      }
    });

    it('deleteAllPendingSafeTxs throws when pending tx payload is inaccessible', async () => {
      globalThis.fetch = (async () => {
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('payload unavailable');
          },
        } as unknown as Response;
      }) as typeof fetch;

      const multiProviderMock = {
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof deleteAllPendingSafeTxs>[1];

      try {
        await deleteAllPendingSafeTxs(
          'test',
          multiProviderMock,
          '0x0000000000000000000000000000000000000001',
        );
        expect.fail('Expected deleteAllPendingSafeTxs to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Pending Safe transactions payload is inaccessible',
        );
      }
    });

    it('deleteAllPendingSafeTxs throws when pending tx list length is inaccessible', async () => {
      const throwingLengthResults = new Proxy(
        [{ safeTxHash: `0x${'11'.repeat(32)}` }],
        {
          get(target, prop, receiver) {
            if (prop === 'length') {
              throw new Error('length unavailable');
            }
            return Reflect.get(target, prop, receiver);
          },
        },
      );
      globalThis.fetch = (async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({ results: throwingLengthResults }),
        } as unknown as Response;
      }) as typeof fetch;

      const multiProviderMock = {
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof deleteAllPendingSafeTxs>[1];

      try {
        await deleteAllPendingSafeTxs(
          'test',
          multiProviderMock,
          '0x0000000000000000000000000000000000000001',
        );
        expect.fail('Expected deleteAllPendingSafeTxs to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Pending Safe transactions list length is inaccessible',
        );
      }
    });

    it('deleteAllPendingSafeTxs throws when pending tx list length is invalid', async () => {
      const invalidLengthResults = new Proxy(
        [{ safeTxHash: `0x${'11'.repeat(32)}` }],
        {
          get(target, prop, receiver) {
            if (prop === 'length') {
              return Number.NaN;
            }
            return Reflect.get(target, prop, receiver);
          },
        },
      );
      globalThis.fetch = (async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({ results: invalidLengthResults }),
        } as unknown as Response;
      }) as typeof fetch;

      const multiProviderMock = {
        getChainMetadata: () => ({
          gnosisSafeTransactionServiceUrl:
            'https://safe-transaction-mainnet.safe.global/api',
        }),
      } as unknown as Parameters<typeof deleteAllPendingSafeTxs>[1];

      try {
        await deleteAllPendingSafeTxs(
          'test',
          multiProviderMock,
          '0x0000000000000000000000000000000000000001',
        );
        expect.fail('Expected deleteAllPendingSafeTxs to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          'Pending Safe transactions list length is invalid: NaN',
        );
      }
    });
  });

  describe(getOwnerChanges.name, () => {
    const expectOwnerChangesError = async (
      currentOwners: unknown,
      expectedOwners: unknown,
      message: string,
    ): Promise<void> => {
      try {
        await getOwnerChanges(currentOwners, expectedOwners);
        expect.fail('Expected getOwnerChanges to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(message);
      }
    };

    it('diffs owners case-insensitively', async () => {
      const currentOwners = [
        '0xaBcd000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
      ];
      const expectedOwners = [
        '0xabcd000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000003',
      ];

      const { ownersToRemove, ownersToAdd } = await getOwnerChanges(
        currentOwners,
        expectedOwners,
      );

      expect(ownersToRemove).to.deep.equal([
        '0x0000000000000000000000000000000000000002',
      ]);
      expect(ownersToAdd).to.deep.equal([
        '0x0000000000000000000000000000000000000003',
      ]);
    });

    it('returns empty arrays when owners are unchanged', async () => {
      const owners = [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
      ];

      const { ownersToRemove, ownersToAdd } = await getOwnerChanges(
        owners,
        owners,
      );

      expect(ownersToRemove).to.deep.equal([]);
      expect(ownersToAdd).to.deep.equal([]);
    });

    it('handles multiple replacements', async () => {
      const currentOwners = [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
        '0x0000000000000000000000000000000000000003',
        '0x0000000000000000000000000000000000000004',
      ];
      const expectedOwners = [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000005',
        '0x0000000000000000000000000000000000000006',
        '0x0000000000000000000000000000000000000004',
      ];

      const { ownersToRemove, ownersToAdd } = await getOwnerChanges(
        currentOwners,
        expectedOwners,
      );

      expect(ownersToRemove).to.deep.equal([
        '0x0000000000000000000000000000000000000002',
        '0x0000000000000000000000000000000000000003',
      ]);
      expect(ownersToAdd).to.deep.equal([
        '0x0000000000000000000000000000000000000005',
        '0x0000000000000000000000000000000000000006',
      ]);
    });

    it('treats reordered owner sets as unchanged', async () => {
      const currentOwners = [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
        '0x0000000000000000000000000000000000000003',
      ];
      const expectedOwners = [
        '0x0000000000000000000000000000000000000003',
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
      ];

      const { ownersToRemove, ownersToAdd } = await getOwnerChanges(
        currentOwners,
        expectedOwners,
      );

      expect(ownersToRemove).to.deep.equal([]);
      expect(ownersToAdd).to.deep.equal([]);
    });

    it('preserves current-order removals and expected-order additions', async () => {
      const currentOwners = [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
        '0x0000000000000000000000000000000000000003',
        '0x0000000000000000000000000000000000000004',
      ];
      const expectedOwners = [
        '0x0000000000000000000000000000000000000004',
        '0x0000000000000000000000000000000000000006',
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000005',
      ];

      const { ownersToRemove, ownersToAdd } = await getOwnerChanges(
        currentOwners,
        expectedOwners,
      );

      expect(ownersToRemove).to.deep.equal([
        '0x0000000000000000000000000000000000000002',
        '0x0000000000000000000000000000000000000003',
      ]);
      expect(ownersToAdd).to.deep.equal([
        '0x0000000000000000000000000000000000000006',
        '0x0000000000000000000000000000000000000005',
      ]);
    });

    it('throws when current owners include duplicate addresses', async () => {
      await expectOwnerChangesError(
        [
          '0x0000000000000000000000000000000000000001',
          '0x0000000000000000000000000000000000000001',
        ],
        ['0x0000000000000000000000000000000000000002'],
        'Duplicate owner address found in current owners: 0x0000000000000000000000000000000000000001',
      );
    });

    it('throws when expected owners include case-insensitive duplicates', async () => {
      await expectOwnerChangesError(
        ['0x0000000000000000000000000000000000000001'],
        [
          '0xabcd000000000000000000000000000000000002',
          '0xABCD000000000000000000000000000000000002',
        ],
        'Duplicate owner address found in expected owners: 0xABCD000000000000000000000000000000000002',
      );
    });

    it('throws when current owners include invalid addresses', async () => {
      await expectOwnerChangesError(
        ['not-an-address'],
        ['0x0000000000000000000000000000000000000002'],
        'Invalid owner address found in current owners: not-an-address',
      );
    });

    it('throws when expected owners include invalid addresses', async () => {
      await expectOwnerChangesError(
        ['0x0000000000000000000000000000000000000001'],
        ['not-an-address'],
        'Invalid owner address found in expected owners: not-an-address',
      );
    });

    it('throws when owner lists are not arrays', async () => {
      await expectOwnerChangesError(
        null,
        ['0x0000000000000000000000000000000000000001'],
        'Owner list for current owners must be an array: null',
      );
      await expectOwnerChangesError(
        ['0x0000000000000000000000000000000000000001'],
        123,
        'Owner list for expected owners must be an array: 123',
      );
    });

    it('throws when owner lists contain non-string entries', async () => {
      await expectOwnerChangesError(
        [123],
        ['0x0000000000000000000000000000000000000001'],
        'Invalid owner address found in current owners: 123',
      );
      const unstringifiableOwner = {
        [Symbol.toPrimitive]: () => {
          throw new Error('boom');
        },
      };
      await expectOwnerChangesError(
        ['0x0000000000000000000000000000000000000001'],
        [unstringifiableOwner],
        'Invalid owner address found in expected owners: <unstringifiable>',
      );
    });

    it('throws when owner list length access is inaccessible', async () => {
      const ownersWithThrowingLength = new Proxy(
        ['0x0000000000000000000000000000000000000001'],
        {
          get(target, property, receiver) {
            if (property === 'length') {
              throw new Error('boom');
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );

      await expectOwnerChangesError(
        ownersWithThrowingLength,
        ['0x0000000000000000000000000000000000000002'],
        'Owner list length is inaccessible for current owners',
      );
    });

    it('throws when owner list length is invalid', async () => {
      const ownersWithInvalidLength = new Proxy(
        ['0x0000000000000000000000000000000000000001'],
        {
          get(target, property, receiver) {
            if (property === 'length') {
              return Number.POSITIVE_INFINITY;
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );

      await expectOwnerChangesError(
        ownersWithInvalidLength,
        ['0x0000000000000000000000000000000000000002'],
        'Owner list length is invalid for current owners: Infinity',
      );
    });

    it('throws when owner list entry access is inaccessible', async () => {
      const ownersWithThrowingEntry = [
        '0x0000000000000000000000000000000000000001',
      ];
      Object.defineProperty(ownersWithThrowingEntry, '0', {
        get() {
          throw new Error('boom');
        },
      });

      await expectOwnerChangesError(
        ['0x0000000000000000000000000000000000000002'],
        ownersWithThrowingEntry,
        'Owner entry is inaccessible for expected owners at index 0',
      );
    });
  });

  describe(parseSafeTx.name, () => {
    it('parses swapOwner tx calldata', () => {
      const prevOwner = '0x0000000000000000000000000000000000000001';
      const oldOwner = '0x0000000000000000000000000000000000000002';
      const newOwner = '0x0000000000000000000000000000000000000004';
      const data = safeInterface.encodeFunctionData('swapOwner', [
        prevOwner,
        oldOwner,
        newOwner,
      ]);

      const decoded = parseSafeTx({
        to: '0x1234567890123456789012345678901234567890',
        data,
        value: BigNumber.from(0),
      });

      expect(decoded.name).to.equal('swapOwner');
      expect(decoded.args[0]).to.equal(prevOwner);
      expect(decoded.args[1]).to.equal(oldOwner);
      expect(decoded.args[2]).to.equal(newOwner);
    });

    it('parses addOwnerWithThreshold tx calldata', () => {
      const newOwner = '0x0000000000000000000000000000000000000005';
      const threshold = 2;
      const data = safeInterface.encodeFunctionData('addOwnerWithThreshold', [
        newOwner,
        threshold,
      ]);

      const decoded = parseSafeTx({
        to: '0x1234567890123456789012345678901234567890',
        data,
        value: BigNumber.from(0),
      });

      expect(decoded.name).to.equal('addOwnerWithThreshold');
      expect(decoded.args[0]).to.equal(newOwner);
      expect(decoded.args[1].toNumber()).to.equal(threshold);
    });

    it('parses changeThreshold tx calldata', () => {
      const newThreshold = 3;
      const data = safeInterface.encodeFunctionData('changeThreshold', [
        newThreshold,
      ]);

      const decoded = parseSafeTx({
        to: '0x1234567890123456789012345678901234567890',
        data,
        value: BigNumber.from(0),
      });

      expect(decoded.name).to.equal('changeThreshold');
      expect(decoded.args[0].toNumber()).to.equal(newThreshold);
    });

    it('parses execTransaction tx calldata', () => {
      const execInterface = new ethers.utils.Interface([
        'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures)',
      ]);
      const to = '0x00000000000000000000000000000000000000aa';
      const data = execInterface.encodeFunctionData('execTransaction', [
        to,
        1,
        '0x1234',
        0,
        0,
        0,
        0,
        '0x0000000000000000000000000000000000000000',
        '0x0000000000000000000000000000000000000000',
        '0x',
      ]);

      const decoded = parseSafeTx({
        to: '0x1234567890123456789012345678901234567890',
        data,
        value: BigNumber.from(0),
      });

      expect(decoded.name).to.equal('execTransaction');
      expect(decoded.args.to).to.equal(getAddress(to));
      expect(decoded.args.value.toNumber()).to.equal(1);
      expect(decoded.args.data).to.equal('0x1234');
      expect(decoded.args.operation).to.equal(0);
    });

    it('parses execTransactionFromModule tx calldata', () => {
      const moduleInterface = new ethers.utils.Interface([
        'function execTransactionFromModule(address to,uint256 value,bytes data,uint8 operation)',
      ]);
      const data = moduleInterface.encodeFunctionData(
        'execTransactionFromModule',
        ['0x00000000000000000000000000000000000000aa', 5, '0x1234', 1],
      );

      const decoded = parseSafeTx({
        to: '0x1234567890123456789012345678901234567890',
        data,
        value: BigNumber.from(0),
      });

      expect(decoded.name).to.equal('execTransactionFromModule');
      expect(decoded.args.to).to.equal(
        getAddress('0x00000000000000000000000000000000000000aa'),
      );
      expect(decoded.args.value.toNumber()).to.equal(5);
      expect(decoded.args.data).to.equal('0x1234');
      expect(decoded.args.operation).to.equal(1);
    });

    it('parses execTransactionFromModuleReturnData tx calldata', () => {
      const moduleInterface = new ethers.utils.Interface([
        'function execTransactionFromModuleReturnData(address to,uint256 value,bytes data,uint8 operation) returns (bool success, bytes returnData)',
      ]);
      const data = moduleInterface.encodeFunctionData(
        'execTransactionFromModuleReturnData',
        ['0x00000000000000000000000000000000000000bb', 9, '0xabcd', 0],
      );

      const decoded = parseSafeTx({
        to: '0x1234567890123456789012345678901234567890',
        data,
        value: BigNumber.from(0),
      });

      expect(decoded.name).to.equal('execTransactionFromModuleReturnData');
      expect(decoded.args.to).to.equal(
        getAddress('0x00000000000000000000000000000000000000bb'),
      );
      expect(decoded.args.value.toNumber()).to.equal(9);
      expect(decoded.args.data).to.equal('0xabcd');
      expect(decoded.args.operation).to.equal(0);
    });

    it('parses approveHash tx calldata', () => {
      const approveHashInterface = new ethers.utils.Interface([
        'function approveHash(bytes32 hashToApprove)',
      ]);
      const hashToApprove =
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const data = approveHashInterface.encodeFunctionData('approveHash', [
        hashToApprove,
      ]);

      const decoded = parseSafeTx({
        to: '0x1234567890123456789012345678901234567890',
        data,
        value: BigNumber.from(0),
      });

      expect(decoded.name).to.equal('approveHash');
      expect(decoded.args.hashToApprove).to.equal(hashToApprove);
    });

    it('parses setup tx calldata', () => {
      const setupInterface = new ethers.utils.Interface([
        'function setup(address[] _owners,uint256 _threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address payable paymentReceiver)',
      ]);
      const owners = [
        '0x00000000000000000000000000000000000000aa',
        '0x00000000000000000000000000000000000000bb',
      ];
      const data = setupInterface.encodeFunctionData('setup', [
        owners,
        2,
        '0x00000000000000000000000000000000000000cc',
        '0x1234',
        '0x00000000000000000000000000000000000000dd',
        '0x00000000000000000000000000000000000000ee',
        0,
        '0x00000000000000000000000000000000000000ff',
      ]);

      const decoded = parseSafeTx({
        to: '0x1234567890123456789012345678901234567890',
        data,
        value: BigNumber.from(0),
      });

      expect(decoded.name).to.equal('setup');
      expect(
        (decoded.args._owners as string[]).map((owner) => owner.toLowerCase()),
      ).to.deep.equal(owners.map((owner) => owner.toLowerCase()));
      expect(decoded.args._threshold.toNumber()).to.equal(2);
      expect(decoded.args.to).to.equal(
        getAddress('0x00000000000000000000000000000000000000cc'),
      );
      expect(decoded.args.data).to.equal('0x1234');
      expect(decoded.args.fallbackHandler).to.equal(
        getAddress('0x00000000000000000000000000000000000000dd'),
      );
    });

    it('throws for calldata that does not match the safe interface', () => {
      expect(() =>
        parseSafeTx({
          to: '0x1234567890123456789012345678901234567890',
          data: '0x12345678',
          value: BigNumber.from(0),
        }),
      ).to.throw();
    });

    it('throws when transaction data is missing', () => {
      expect(() =>
        parseSafeTx({
          to: '0x1234567890123456789012345678901234567890',
          value: BigNumber.from(0),
        }),
      ).to.throw('Safe transaction data is required');
      expect(() =>
        parseSafeTx({
          to: '0x1234567890123456789012345678901234567890',
          data: null,
          value: BigNumber.from(0),
        }),
      ).to.throw('Safe transaction data is required');
    });

    it('throws when transaction payload is non-object', () => {
      expect(() => parseSafeTx(undefined)).to.throw(
        'Safe transaction payload must be an object: undefined',
      );
      expect(() => parseSafeTx(null)).to.throw(
        'Safe transaction payload must be an object: null',
      );
      expect(() => parseSafeTx(123)).to.throw(
        'Safe transaction payload must be an object: 123',
      );
    });

    it('throws when transaction payload fields are inaccessible', () => {
      const inaccessiblePayload = {
        get data() {
          throw new Error('boom');
        },
      };
      expect(() => parseSafeTx(inaccessiblePayload)).to.throw(
        'Safe transaction payload fields are inaccessible',
      );
    });

    it('throws when transaction data is only whitespace', () => {
      expect(() =>
        parseSafeTx({
          to: '0x1234567890123456789012345678901234567890',
          data: '   ',
          value: BigNumber.from(0),
        }),
      ).to.throw('Safe transaction data is required');
    });

    it('throws when transaction data is not hex', () => {
      expect(() =>
        parseSafeTx({
          to: '0x1234567890123456789012345678901234567890',
          data: 'not-hex',
          value: BigNumber.from(0),
        }),
      ).to.throw('Safe transaction data must be hex');
      expect(() =>
        parseSafeTx({
          to: '0x1234567890123456789012345678901234567890',
          data: '0x123',
          value: BigNumber.from(0),
        }),
      ).to.throw('Safe transaction data must be hex');
      expect(() =>
        parseSafeTx({
          to: '0x1234567890123456789012345678901234567890',
          data: '123',
          value: BigNumber.from(0),
        }),
      ).to.throw('Safe transaction data must be hex');
      expect(() =>
        parseSafeTx({
          to: '0x1234567890123456789012345678901234567890',
          data: 123,
          value: BigNumber.from(0),
        }),
      ).to.throw('Safe transaction data must be hex');
    });

    it('throws deterministic error for unstringifiable transaction data inputs', () => {
      const unstringifiableInput = {
        [Symbol.toPrimitive]: () => {
          throw new Error('boom');
        },
      };

      expect(() =>
        parseSafeTx({
          to: '0x1234567890123456789012345678901234567890',
          data: unstringifiableInput,
          value: BigNumber.from(0),
        }),
      ).to.throw('Safe transaction data must be hex');
    });

    it('throws when transaction data does not include selector', () => {
      expect(() =>
        parseSafeTx({
          to: '0x1234567890123456789012345678901234567890',
          data: '0x12',
          value: BigNumber.from(0),
        }),
      ).to.throw('Safe transaction data must include function selector');
    });

    it('throws when transaction data is only 0x prefix', () => {
      expect(() =>
        parseSafeTx({
          to: '0x1234567890123456789012345678901234567890',
          data: '0x',
          value: BigNumber.from(0),
        }),
      ).to.throw('Safe transaction data must include function selector');
    });

    it('throws when transaction data is only uppercase 0X prefix', () => {
      expect(() =>
        parseSafeTx({
          to: '0x1234567890123456789012345678901234567890',
          data: '0X',
          value: BigNumber.from(0),
        }),
      ).to.throw('Safe transaction data must include function selector');
    });

    it('throws when short transaction data is unprefixed', () => {
      expect(() =>
        parseSafeTx({
          to: '0x1234567890123456789012345678901234567890',
          data: '12',
          value: BigNumber.from(0),
        }),
      ).to.throw('Safe transaction data must include function selector');
      expect(() =>
        parseSafeTx({
          to: '0x1234567890123456789012345678901234567890',
          data: '0X12',
          value: BigNumber.from(0),
        }),
      ).to.throw('Safe transaction data must include function selector');
    });

    it('accepts transaction data with uppercase 0X prefix', () => {
      const data = safeInterface.encodeFunctionData('changeThreshold', [2]);

      const decoded = parseSafeTx({
        to: '0x1234567890123456789012345678901234567890',
        data: `0X${data.slice(2)}`,
        value: BigNumber.from(0),
      });

      expect(decoded.name).to.equal('changeThreshold');
      expect(decoded.args._threshold.toNumber()).to.equal(2);
    });

    it('accepts uppercase transaction data payload with 0X prefix', () => {
      const data = safeInterface
        .encodeFunctionData('changeThreshold', [2])
        .slice(2)
        .toUpperCase();

      const decoded = parseSafeTx({
        to: '0x1234567890123456789012345678901234567890',
        data: `0X${data}`,
        value: BigNumber.from(0),
      });

      expect(decoded.name).to.equal('changeThreshold');
      expect(decoded.args._threshold.toNumber()).to.equal(2);
    });

    it('accepts mixed-case transaction data payload with 0x prefix', () => {
      const data = safeInterface
        .encodeFunctionData('changeThreshold', [2])
        .slice(2)
        .replace(/a/g, 'A')
        .replace(/c/g, 'C')
        .replace(/e/g, 'E');

      const decoded = parseSafeTx({
        to: '0x1234567890123456789012345678901234567890',
        data: `0x${data}`,
        value: BigNumber.from(0),
      });

      expect(decoded.name).to.equal('changeThreshold');
      expect(decoded.args._threshold.toNumber()).to.equal(2);
    });

    it('accepts transaction data without 0x prefix', () => {
      const data = safeInterface.encodeFunctionData('changeThreshold', [2]);

      const decoded = parseSafeTx({
        to: '0x1234567890123456789012345678901234567890',
        data: data.slice(2),
        value: BigNumber.from(0),
      });

      expect(decoded.name).to.equal('changeThreshold');
      expect(decoded.args._threshold.toNumber()).to.equal(2);
    });

    it('accepts transaction data without 0x prefix in uppercase', () => {
      const data = safeInterface
        .encodeFunctionData('changeThreshold', [2])
        .slice(2)
        .toUpperCase();

      const decoded = parseSafeTx({
        to: '0x1234567890123456789012345678901234567890',
        data,
        value: BigNumber.from(0),
      });

      expect(decoded.name).to.equal('changeThreshold');
      expect(decoded.args._threshold.toNumber()).to.equal(2);
    });

    it('accepts transaction data with surrounding whitespace', () => {
      const data = safeInterface.encodeFunctionData('changeThreshold', [2]);

      const decoded = parseSafeTx({
        to: '0x1234567890123456789012345678901234567890',
        data: `  ${data}  `,
        value: BigNumber.from(0),
      });

      expect(decoded.name).to.equal('changeThreshold');
      expect(decoded.args._threshold.toNumber()).to.equal(2);
    });

    it('parses safe tx calldata when value is omitted', () => {
      const data = safeInterface.encodeFunctionData('changeThreshold', [2]);

      const decoded = parseSafeTx({
        to: '0x1234567890123456789012345678901234567890',
        data,
      });

      expect(decoded.name).to.equal('changeThreshold');
      expect(decoded.args[0].toNumber()).to.equal(2);
    });
  });

  describe(asHex.name, () => {
    it('returns prefixed hex values unchanged', () => {
      expect(asHex('0x1234')).to.equal('0x1234');
    });

    it('normalizes uppercase 0X prefixes', () => {
      expect(asHex('0X1234')).to.equal('0x1234');
      expect(asHex('0XABCD')).to.equal('0xabcd');
    });

    it('normalizes mixed-case prefixed hex payloads', () => {
      expect(asHex('0xaBcD')).to.equal('0xabcd');
    });

    it('prefixes unprefixed hex values', () => {
      expect(asHex('1234')).to.equal('0x1234');
      expect(asHex('ABCD')).to.equal('0xabcd');
      expect(asHex('AbCd')).to.equal('0xabcd');
    });

    it('trims surrounding whitespace from hex values', () => {
      expect(asHex('  0x1234  ')).to.equal('0x1234');
      expect(asHex('  1234  ')).to.equal('0x1234');
    });

    it('throws when hex value is missing', () => {
      expect(() => asHex()).to.throw('Hex value is required');
      expect(() => asHex('')).to.throw('Hex value is required');
      expect(() => asHex('   ')).to.throw('Hex value is required');
      expect(() => asHex(null)).to.throw('Hex value is required');
    });

    it('throws when hex value has invalid characters', () => {
      expect(() => asHex('xyz')).to.throw('Hex value must be valid hex: xyz');
      expect(() => asHex('0xxyz')).to.throw(
        'Hex value must be valid hex: 0xxyz',
      );
      expect(() => asHex('0x123')).to.throw(
        'Hex value must be valid hex: 0x123',
      );
      expect(() => asHex('123')).to.throw('Hex value must be valid hex: 123');
      expect(() => asHex(123)).to.throw('Hex value must be valid hex: 123');
    });

    it('throws deterministic error for unstringifiable non-string inputs', () => {
      const unstringifiableInput = {
        [Symbol.toPrimitive]: () => {
          throw new Error('boom');
        },
      };

      expect(() => asHex(unstringifiableInput)).to.throw(
        'Hex value must be valid hex: <unstringifiable>',
      );
      expect(() =>
        asHex(unstringifiableInput, {
          invalid: 'custom invalid message',
        }),
      ).to.throw('custom invalid message');
    });

    it('supports custom error messages', () => {
      expect(() =>
        asHex(' ', {
          required: 'custom required message',
          invalid: 'custom invalid message',
        }),
      ).to.throw('custom required message');

      expect(() =>
        asHex('0xxyz', {
          required: 'custom required message',
          invalid: 'custom invalid message',
        }),
      ).to.throw('custom invalid message');

      expect(() =>
        asHex('0x123', {
          required: 'custom required message',
          invalid: 'custom invalid message',
        }),
      ).to.throw('custom invalid message');

      expect(() =>
        asHex(123, {
          required: 'custom required message',
          invalid: 'custom invalid message',
        }),
      ).to.throw('custom invalid message');
    });

    it('uses default message when only one override is provided', () => {
      expect(() =>
        asHex(' ', {
          invalid: 'custom invalid message',
        }),
      ).to.throw('Hex value is required');

      expect(() =>
        asHex('0xxyz', {
          required: 'custom required message',
        }),
      ).to.throw('Hex value must be valid hex: 0xxyz');
    });
  });

  describe(decodeMultiSendData.name, () => {
    function encodeMultiSendTx(params: {
      operation: number;
      to: string;
      value: bigint;
      data: `0x${string}`;
    }): string {
      const operationHex = params.operation.toString(16).padStart(2, '0');
      const toHex = params.to.replace('0x', '').padStart(40, '0');
      const valueHex = params.value.toString(16).padStart(64, '0');
      const dataHex = params.data.replace('0x', '');
      const dataLengthHex = (dataHex.length / 2).toString(16).padStart(64, '0');
      return `${operationHex}${toHex}${valueHex}${dataLengthHex}${dataHex}`;
    }

    it('decodes multisend payload', () => {
      const to = '0x00000000000000000000000000000000000000aa';
      const txBytes = `0x${encodeMultiSendTx({
        operation: 0,
        to,
        value: 7n,
        data: '0x1234',
      })}` as `0x${string}`;

      const encoded = encodeFunctionData({
        abi: parseAbi(['function multiSend(bytes transactions)']),
        functionName: 'multiSend',
        args: [txBytes],
      });

      const decoded = decodeMultiSendData(encoded);
      expect(decoded).to.have.length(1);
      expect(decoded[0].operation).to.equal(0);
      expect(decoded[0].to).to.equal(getAddress(to));
      expect(decoded[0].value).to.equal('7');
      expect(decoded[0].data).to.equal('0x1234');
    });

    it('decodes multisend payload with multiple operations', () => {
      const txBytes = `0x${[
        encodeMultiSendTx({
          operation: 0,
          to: '0x00000000000000000000000000000000000000aa',
          value: 7n,
          data: '0x1234',
        }),
        encodeMultiSendTx({
          operation: 1,
          to: '0x00000000000000000000000000000000000000bb',
          value: 0n,
          data: '0x',
        }),
      ].join('')}` as `0x${string}`;

      const encoded = encodeFunctionData({
        abi: parseAbi(['function multiSend(bytes transactions)']),
        functionName: 'multiSend',
        args: [txBytes],
      });

      const decoded = decodeMultiSendData(encoded);
      expect(decoded).to.have.length(2);
      expect(decoded[0]).to.deep.include({
        operation: 0,
        to: getAddress('0x00000000000000000000000000000000000000aa'),
        value: '7',
        data: '0x1234',
      });
      expect(decoded[1]).to.deep.include({
        operation: 1,
        to: getAddress('0x00000000000000000000000000000000000000bb'),
        value: '0',
        data: '0x',
      });
    });

    it('returns empty list when multisend payload has no inner txs', () => {
      const encoded = encodeFunctionData({
        abi: parseAbi(['function multiSend(bytes transactions)']),
        functionName: 'multiSend',
        args: ['0x'],
      });

      const decoded = decodeMultiSendData(encoded);
      expect(decoded).to.deep.equal([]);
    });

    it('accepts multisend calldata without 0x prefix', () => {
      const txBytes = `0x${encodeMultiSendTx({
        operation: 0,
        to: '0x00000000000000000000000000000000000000aa',
        value: 1n,
        data: '0x',
      })}` as `0x${string}`;

      const encoded = encodeFunctionData({
        abi: parseAbi(['function multiSend(bytes transactions)']),
        functionName: 'multiSend',
        args: [txBytes],
      });

      const decoded = decodeMultiSendData(encoded.slice(2));
      expect(decoded).to.have.length(1);
      expect(decoded[0].to).to.equal(
        getAddress('0x00000000000000000000000000000000000000aa'),
      );
      expect(decoded[0].value).to.equal('1');
    });

    it('throws when calldata is not a multisend invocation', () => {
      const nonMultiSendData = encodeFunctionData({
        abi: parseAbi(['function transfer(address to, uint256 amount)']),
        functionName: 'transfer',
        args: ['0x00000000000000000000000000000000000000aa', 1n],
      });

      expect(() => decodeMultiSendData(nonMultiSendData)).to.throw();
    });

    it('throws when calldata is empty', () => {
      expect(() => decodeMultiSendData('')).to.throw('Hex value is required');
      expect(() => decodeMultiSendData('   ')).to.throw(
        'Hex value is required',
      );
      expect(() => decodeMultiSendData(null)).to.throw('Hex value is required');
    });

    it('throws when calldata does not include multisend selector', () => {
      expect(() => decodeMultiSendData('0x')).to.throw(
        'Invalid multisend payload: missing multisend selector',
      );
      expect(() => decodeMultiSendData(' 0x ')).to.throw(
        'Invalid multisend payload: missing multisend selector',
      );
      expect(() => decodeMultiSendData('0X')).to.throw(
        'Invalid multisend payload: missing multisend selector',
      );
      expect(() => decodeMultiSendData('12')).to.throw(
        'Invalid multisend payload: missing multisend selector',
      );
      expect(() => decodeMultiSendData('0x12')).to.throw(
        'Invalid multisend payload: missing multisend selector',
      );
      expect(() => decodeMultiSendData('AB')).to.throw(
        'Invalid multisend payload: missing multisend selector',
      );
    });

    it('accepts calldata with surrounding whitespace', () => {
      const txBytes = `0x${encodeMultiSendTx({
        operation: 0,
        to: '0x00000000000000000000000000000000000000aa',
        value: 1n,
        data: '0x',
      })}` as `0x${string}`;

      const encoded = encodeFunctionData({
        abi: parseAbi(['function multiSend(bytes transactions)']),
        functionName: 'multiSend',
        args: [txBytes],
      });

      const decoded = decodeMultiSendData(`  ${encoded}  `);
      expect(decoded).to.have.length(1);
      expect(decoded[0].to).to.equal(
        getAddress('0x00000000000000000000000000000000000000aa'),
      );
    });

    it('accepts calldata with uppercase 0X prefix', () => {
      const txBytes = `0x${encodeMultiSendTx({
        operation: 0,
        to: '0x00000000000000000000000000000000000000aa',
        value: 1n,
        data: '0x',
      })}` as `0x${string}`;

      const encoded = encodeFunctionData({
        abi: parseAbi(['function multiSend(bytes transactions)']),
        functionName: 'multiSend',
        args: [txBytes],
      });

      const decoded = decodeMultiSendData(
        `0X${encoded.slice(2).toUpperCase()}`,
      );
      expect(decoded).to.have.length(1);
      expect(decoded[0].to).to.equal(
        getAddress('0x00000000000000000000000000000000000000aa'),
      );
    });

    it('accepts uppercase calldata without 0x prefix', () => {
      const txBytes = `0x${encodeMultiSendTx({
        operation: 0,
        to: '0x00000000000000000000000000000000000000aa',
        value: 1n,
        data: '0x',
      })}` as `0x${string}`;

      const encoded = encodeFunctionData({
        abi: parseAbi(['function multiSend(bytes transactions)']),
        functionName: 'multiSend',
        args: [txBytes],
      });

      const decoded = decodeMultiSendData(encoded.slice(2).toUpperCase());
      expect(decoded).to.have.length(1);
      expect(decoded[0].to).to.equal(
        getAddress('0x00000000000000000000000000000000000000aa'),
      );
    });

    it('throws when calldata is not valid hex', () => {
      expect(() => decodeMultiSendData('xyz')).to.throw(
        'Hex value must be valid hex: xyz',
      );
      expect(() => decodeMultiSendData('0x123')).to.throw(
        'Hex value must be valid hex: 0x123',
      );
      expect(() => decodeMultiSendData('123')).to.throw(
        'Hex value must be valid hex: 123',
      );
      expect(() => decodeMultiSendData(123)).to.throw(
        'Hex value must be valid hex: 123',
      );
    });

    it('throws deterministic error for unstringifiable calldata inputs', () => {
      const unstringifiableInput = {
        [Symbol.toPrimitive]: () => {
          throw new Error('boom');
        },
      };

      expect(() => decodeMultiSendData(unstringifiableInput)).to.throw(
        'Hex value must be valid hex: <unstringifiable>',
      );
    });

    it('throws when an inner multisend tx payload is truncated', () => {
      const malformedTxBytes = `0x${encodeMultiSendTx({
        operation: 0,
        to: '0x00000000000000000000000000000000000000aa',
        value: 0n,
        data: '0x1234',
      }).slice(0, -2)}` as `0x${string}`;

      const encoded = encodeFunctionData({
        abi: parseAbi(['function multiSend(bytes transactions)']),
        functionName: 'multiSend',
        args: [malformedTxBytes],
      });

      expect(() => decodeMultiSendData(encoded)).to.throw(
        'Invalid multisend payload: truncated data',
      );
    });

    it('throws when multisend tx header is truncated', () => {
      const encoded = encodeFunctionData({
        abi: parseAbi(['function multiSend(bytes transactions)']),
        functionName: 'multiSend',
        args: ['0x00'],
      });

      expect(() => decodeMultiSendData(encoded)).to.throw(
        'Invalid multisend payload: truncated to',
      );
    });

    it('throws when multisend tx data length overflows safe integer bounds', () => {
      const overflowHeader = [
        '00',
        '00000000000000000000000000000000000000aa',
        '0000000000000000000000000000000000000000000000000000000000000000',
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      ].join('');

      const encoded = encodeFunctionData({
        abi: parseAbi(['function multiSend(bytes transactions)']),
        functionName: 'multiSend',
        args: [`0x${overflowHeader}`],
      });

      expect(() => decodeMultiSendData(encoded)).to.throw(
        'Invalid multisend payload: malformed data length',
      );
    });

    it('throws when multisend tx operation is unsupported', () => {
      const invalidOperationTxBytes = `0x${[
        '02',
        '00000000000000000000000000000000000000aa',
        '0000000000000000000000000000000000000000000000000000000000000000',
        '0000000000000000000000000000000000000000000000000000000000000000',
      ].join('')}` as `0x${string}`;

      const encoded = encodeFunctionData({
        abi: parseAbi(['function multiSend(bytes transactions)']),
        functionName: 'multiSend',
        args: [invalidOperationTxBytes],
      });

      expect(() => decodeMultiSendData(encoded)).to.throw(
        'Invalid multisend payload: unsupported operation 2',
      );
    });
  });

  describe(getKnownMultiSendAddresses.name, () => {
    it('uses expected default safe deployment versions', () => {
      expect([...DEFAULT_SAFE_DEPLOYMENT_VERSIONS]).to.deep.equal([
        '1.3.0',
        '1.4.1',
      ]);
    });

    it('returns known deployment addresses for multisend contracts', () => {
      const deployments = getKnownMultiSendAddresses();
      expect(deployments.multiSend.length).to.be.greaterThan(0);
      expect(deployments.multiSendCallOnly.length).to.be.greaterThan(0);
      expect(new Set(deployments.multiSend).size).to.equal(
        deployments.multiSend.length,
      );
      expect(new Set(deployments.multiSendCallOnly).size).to.equal(
        deployments.multiSendCallOnly.length,
      );
    });

    it('deduplicates addresses when deployment versions repeat', () => {
      const repeated = getKnownMultiSendAddresses(['1.3.0', '1.3.0']);
      const single = getKnownMultiSendAddresses(['1.3.0']);

      expect(repeated.multiSend).to.deep.equal(single.multiSend);
      expect(repeated.multiSendCallOnly).to.deep.equal(
        single.multiSendCallOnly,
      );
    });

    it('throws for unknown safe deployment version', () => {
      expect(() => getKnownMultiSendAddresses(['0.0.0'])).to.throw(
        'MultiSend and MultiSendCallOnly deployments not found for version 0.0.0',
      );
    });

    it('throws deterministic message for malformed safe deployment version', () => {
      expect(() => getKnownMultiSendAddresses(['bad.version'])).to.throw(
        'MultiSend and MultiSendCallOnly deployments not found for version bad.version',
      );
    });

    it('throws for empty safe deployment version input', () => {
      expect(() => getKnownMultiSendAddresses([''])).to.throw(
        'Safe deployment version is required',
      );
      expect(() => getKnownMultiSendAddresses(['   '])).to.throw(
        'Safe deployment version is required',
      );
    });

    it('throws for non-string safe deployment version input', () => {
      expect(() => getKnownMultiSendAddresses([123])).to.throw(
        'Safe deployment version must be a string: 123',
      );

      const unstringifiableVersion = {
        [Symbol.toPrimitive]: () => {
          throw new Error('boom');
        },
      };
      expect(() =>
        getKnownMultiSendAddresses([unstringifiableVersion]),
      ).to.throw('Safe deployment version must be a string: <unstringifiable>');
    });

    it('throws for non-array safe deployment versions input', () => {
      expect(() => getKnownMultiSendAddresses(123)).to.throw(
        'Safe deployment versions must be an array: 123',
      );
      expect(() => getKnownMultiSendAddresses(null)).to.throw(
        'Safe deployment versions must be an array: null',
      );

      const unstringifiableVersions = {
        [Symbol.toPrimitive]: () => {
          throw new Error('boom');
        },
      };
      expect(() =>
        getKnownMultiSendAddresses(unstringifiableVersions),
      ).to.throw(
        'Safe deployment versions must be an array: <unstringifiable>',
      );
    });

    it('throws when safe deployment versions length access is inaccessible', () => {
      const versionsWithThrowingLength = new Proxy(['1.3.0'], {
        get(target, property, receiver) {
          if (property === 'length') {
            throw new Error('boom');
          }
          return Reflect.get(target, property, receiver);
        },
      });

      expect(() =>
        getKnownMultiSendAddresses(versionsWithThrowingLength),
      ).to.throw('Safe deployment versions list length is inaccessible');
    });

    it('throws when safe deployment versions length is invalid', () => {
      const versionsWithInvalidLength = new Proxy(['1.3.0'], {
        get(target, property, receiver) {
          if (property === 'length') {
            return Number.POSITIVE_INFINITY;
          }
          return Reflect.get(target, property, receiver);
        },
      });

      expect(() =>
        getKnownMultiSendAddresses(versionsWithInvalidLength),
      ).to.throw('Safe deployment versions list length is invalid: Infinity');
    });

    it('throws when safe deployment version entry access is inaccessible', () => {
      const versionsWithThrowingEntry = ['1.3.0'];
      Object.defineProperty(versionsWithThrowingEntry, '0', {
        get() {
          throw new Error('boom');
        },
      });

      expect(() =>
        getKnownMultiSendAddresses(versionsWithThrowingEntry),
      ).to.throw('Safe deployment version entry is inaccessible at index 0');
    });

    it('accepts safe deployment versions with surrounding whitespace', () => {
      const trimmed = getKnownMultiSendAddresses(['1.3.0']);
      const spaced = getKnownMultiSendAddresses(['  1.3.0  ']);

      expect(spaced.multiSend).to.deep.equal(trimmed.multiSend);
      expect(spaced.multiSendCallOnly).to.deep.equal(trimmed.multiSendCallOnly);
    });
  });
});
