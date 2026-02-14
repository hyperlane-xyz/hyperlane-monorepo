import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';
import { encodeFunctionData, getAddress, parseAbi } from 'viem';

import {
  DEFAULT_SAFE_DEPLOYMENT_VERSIONS,
  asHex,
  createSafeTransactionData,
  decodeMultiSendData,
  getKnownMultiSendAddresses,
  getOwnerChanges,
  hasSafeServiceTransactionPayload,
  isLegacySafeApi,
  normalizeSafeServiceUrl,
  parseSafeTx,
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
    const expectLegacyStatus = async (
      version: string,
      isLegacy: boolean,
    ): Promise<void> => {
      expect(await isLegacySafeApi(version)).to.equal(isLegacy);
    };

    const expectInvalidSafeApiVersion = async (
      version: string,
    ): Promise<void> => {
      try {
        await isLegacySafeApi(version);
        expect.fail('Expected isLegacySafeApi to throw');
      } catch (error) {
        expect((error as Error).message).to.equal(
          `Invalid Safe API version: ${version}`,
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

    it('prefers multiprovider private key when signer is not provided', async () => {
      const wallet = ethers.Wallet.createRandom();
      const multiProviderMock: SignerProvider = {
        getSigner: () => wallet,
      };

      const signer = await resolveSafeSigner('test', multiProviderMock);
      expect(signer).to.equal(wallet.privateKey);
    });

    it('falls back to signer address when private key is unavailable', async () => {
      const signerAddress = '0x2222222222222222222222222222222222222222';
      const multiProviderMock: SignerProvider = {
        getSigner: () => new ethers.VoidSigner(signerAddress),
      };

      const signer = await resolveSafeSigner('test', multiProviderMock);
      expect(signer).to.equal(signerAddress);
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
  });

  describe(createSafeTransactionData.name, () => {
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
  });

  describe(getOwnerChanges.name, () => {
    const expectOwnerChangesError = async (
      currentOwners: string[],
      expectedOwners: string[],
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
    });

    it('throws when transaction data is not hex', () => {
      expect(() =>
        parseSafeTx({
          to: '0x1234567890123456789012345678901234567890',
          data: 'not-hex',
          value: BigNumber.from(0),
        }),
      ).to.throw('Safe transaction data must be hex');
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

    it('prefixes unprefixed hex values', () => {
      expect(asHex('1234')).to.equal('0x1234');
    });

    it('trims surrounding whitespace from hex values', () => {
      expect(asHex('  0x1234  ')).to.equal('0x1234');
      expect(asHex('  1234  ')).to.equal('0x1234');
    });

    it('throws when hex value is missing', () => {
      expect(() => asHex()).to.throw('Hex value is required');
      expect(() => asHex('')).to.throw('Hex value is required');
      expect(() => asHex('   ')).to.throw('Hex value is required');
    });

    it('throws when hex value has invalid characters', () => {
      expect(() => asHex('xyz')).to.throw('Hex value must be valid hex: xyz');
      expect(() => asHex('0xxyz')).to.throw(
        'Hex value must be valid hex: 0xxyz',
      );
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

    it('throws when calldata is not valid hex', () => {
      expect(() => decodeMultiSendData('xyz')).to.throw(
        'Hex value must be valid hex: xyz',
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

    it('throws for empty safe deployment version input', () => {
      expect(() => getKnownMultiSendAddresses([''])).to.throw(
        'Safe deployment version is required',
      );
      expect(() => getKnownMultiSendAddresses(['   '])).to.throw(
        'Safe deployment version is required',
      );
    });

    it('accepts safe deployment versions with surrounding whitespace', () => {
      const trimmed = getKnownMultiSendAddresses(['1.3.0']);
      const spaced = getKnownMultiSendAddresses(['  1.3.0  ']);

      expect(spaced.multiSend).to.deep.equal(trimmed.multiSend);
      expect(spaced.multiSendCallOnly).to.deep.equal(trimmed.multiSendCallOnly);
    });
  });
});
