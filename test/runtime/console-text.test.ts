import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { consoleText, systemOemCodePage } from '../../src/runtime/console-text.ts';

// "오류: 프로세스를 찾을 수 없습니다." as taskkill writes it on a Korean system, in code page 949.
const korean949 = Buffer.from('bfc0b7f93a20c7c1b7cebcbcbdbab8a620c3a3c0bb20bcf620bef8bdc0b4cfb4d92e', 'hex');

describe('consoleText', () => {
  it('reads the bytes of a Windows tool in the system\'s OEM code page when they are not UTF-8 (the gate of resumable runs)', () => {
    assert.equal(consoleText(korean949, () => 949), '오류: 프로세스를 찾을 수 없습니다.');
  });

  it('takes valid UTF-8 as it is, as a console set to code page 65001 writes it, and asks for no code page', () => {
    let asked = false;
    const text = consoleText(Buffer.from('오류: Access is denied.', 'utf8'), () => {
      asked = true;
      return 949;
    });
    assert.equal(text, '오류: Access is denied.');
    assert.equal(asked, false, 'no registry read when the bytes are UTF-8');
    assert.equal(consoleText(Buffer.from('Access is denied.\r\n'), () => 437), 'Access is denied.\r\n', 'ASCII is UTF-8 too');
  });

  it('reads the bytes as UTF-8, as before, for a code page it cannot decode or does not know', () => {
    assert.equal(consoleText(Buffer.from([0x41, 0xff]), () => 437), 'A�', 'code page 437 has no decoder');
    assert.equal(consoleText(Buffer.from([0x41, 0xff]), () => null), 'A�', 'no code page found');
    assert.equal(consoleText(Buffer.alloc(0), () => 949), '');
  });

  it('decodes the other OEM code pages of East Asia and Cyrillic', () => {
    // "エラー" in Shift_JIS (932), "错误" in GBK (936), "錯誤" in Big5 (950), "Ошибка" in code page 866.
    assert.equal(consoleText(Buffer.from('83478389815b', 'hex'), () => 932), 'エラー');
    assert.equal(consoleText(Buffer.from('b4edcef3', 'hex'), () => 936), '错误');
    assert.equal(consoleText(Buffer.from('bff9bb7e', 'hex'), () => 950), '錯誤');
    assert.equal(consoleText(Buffer.from('8ee8a8a1aaa0', 'hex'), () => 866), 'Ошибка');
  });
});

describe('systemOemCodePage', () => {
  it('reads a positive code page from the registry on Windows, and none elsewhere', () => {
    const codePage = systemOemCodePage();
    if (process.platform === 'win32') assert.ok(Number.isInteger(codePage) && codePage! > 0, String(codePage));
    else assert.equal(codePage, null);
  });
});
