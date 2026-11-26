import { strToU8, zipSync } from 'fflate';

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colIndexToLetters(col: number): string {
  let n = col;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

interface CellSpec {
  col: number;
  v?: string | number;
  /** style index in styles.xml cellXfs */
  s?: number;
  /** hyperlink URL */
  hl?: string;
}

interface RowSpec {
  r: number;
  hidden?: boolean;
  cells: CellSpec[];
}

interface SheetSpec {
  name: string;
  /** 故意乱序的物理文件编号，用于验证严格按 workbook.xml.rels 配对 */
  fileNum: number;
  state?: 'visible' | 'hidden';
  rows: RowSpec[];
  merges?: string[];
}

/**
 * 样式索引约定（styles.xml cellXfs）：
 * 0: 无底色 General
 * 1: 绿底 #92D050 (已完成)
 * 2: 黄底 #FFC000 (进行中)
 * 3: 蓝底 #8CDDFA (漫画进行中)
 * 4: 红底 #FF0000 (作品横幅)
 * 5: 深灰底 #939393 (搁置作品横幅)
 * 6: 浅灰底 #BFBFBF (搁置行)
 * 7: 日期格式 302 yyyy/m/d;@ (无底色)
 * 8: 时长格式 301 h:mm;@ (绿底 #92D050)
 * 9: 主题色 accent6 (#70AD47 绿) + tint 0.4
 */
function buildStylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2">
    <numFmt numFmtId="301" formatCode="h:mm;@"/>
    <numFmt numFmtId="302" formatCode="yyyy/m/d;@"/>
  </numFmts>
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="9">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF92D050"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFC000"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF8CDDFA"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFF0000"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF939393"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFBFBFBF"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor theme="9" tint="0"/></patternFill></fill>
  </fills>
  <borders count="1"><border/></borders>
  <cellXfs count="10">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
    <xf numFmtId="0" fontId="0" fillId="2" borderId="0"/>
    <xf numFmtId="0" fontId="0" fillId="3" borderId="0"/>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="0"/>
    <xf numFmtId="0" fontId="0" fillId="5" borderId="0"/>
    <xf numFmtId="0" fontId="0" fillId="6" borderId="0"/>
    <xf numFmtId="0" fontId="0" fillId="7" borderId="0"/>
    <xf numFmtId="302" fontId="0" fillId="0" borderId="0"/>
    <xf numFmtId="301" fontId="0" fillId="2" borderId="0"/>
    <xf numFmtId="0" fontId="0" fillId="8" borderId="0"/>
  </cellXfs>
</styleSheet>`;
}

function buildThemeXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">
  <a:themeElements>
    <a:clrScheme name="Office">
      <a:dk1><a:srgbClr val="000000"/></a:dk1>
      <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="44546A"/></a:dk2>
      <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
      <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
      <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
      <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
      <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
      <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
      <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
      <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
  </a:themeElements>
</a:theme>`;
}

/**
 * 构建完全脱敏的合成多表 .xlsx 测试小样（零真实隐私数据），覆盖第 8 节全部边界特征。
 */
export function buildSampleWorkbookBuffer(): Uint8Array {
  // 故意打乱 fileNum 顺序验证 workbook.xml.rels 严格配对
  const sheets: SheetSpec[] = [
    {
      name: '长视频全熟',
      fileNum: 7,
      rows: [
        { r: 1, cells: [{ col: 2, v: '注：' }] },
        {
          r: 2,
          cells: [
            { col: 2, v: '分段' },
            { col: 3, v: '时轴' },
            { col: 4, v: '翻译' },
          ],
        },
        // 灰块搁置作品
        {
          r: 3,
          hidden: true,
          cells: [
            { col: 1, s: 5 },
            { col: 2, v: '示例搁置联动表', s: 5 },
          ],
        },
        {
          r: 4,
          hidden: true,
          cells: [
            { col: 1, s: 6 },
            { col: 2, v: '0-20', s: 6 },
            { col: 3, v: '耗子', s: 6 },
            { col: 4, v: '3t已一校', s: 6 },
          ],
        },
        // 含百度网盘分享文本的已发布作品
        {
          r: 5,
          hidden: true,
          cells: [
            { col: 1, s: 4 },
            { col: 2, v: '示例特别节目第一期', s: 4 },
          ],
        },
        {
          r: 6,
          hidden: true,
          cells: [
            { col: 1, v: 'P1', s: 1 },
            { col: 2, v: '00:00 - 10:00', s: 1 },
            { col: 3, v: '竹叶（歌轴）/养得累', s: 9 }, // theme accent6 绿
            { col: 4, v: '耗子（后半）', s: 1 },
            { col: 5, v: '斗笠', s: 1 },
            { col: 7, v: '片源：2025.09.21' },
            { col: 8, v: 'AniLive' },
            {
              col: 9,
              v: '通过网盘分享的文件：示例节目一.mp4\r\n链接: https://pan.baidu.com/s/1ExampleShareA 提取码: abcd',
              hl: 'https://pan.baidu.com/s/1ExampleShareA',
            },
            { col: 10, v: '第一行规范\r\n第二行规范' },
          ],
        },
        // 活跃未发布作品（含无色但有人名的工序格 -> 绝不能静默判 done！）
        {
          r: 7,
          cells: [
            { col: 1, s: 4 },
            { col: 2, v: '示例活跃演唱会', s: 4 },
          ],
        },
        {
          r: 8,
          cells: [
            { col: 1, v: 'P1' },
            { col: 2, v: '00:00 - 30:00' },
            { col: 3, v: '1zero', s: 1 }, // 绿 -> done，绑定管理员 1zero
            { col: 4, v: 'asama', s: 0 }, // 无色但有人名 -> 必须 not_started！
            { col: 5, v: '斗笠斗笠', s: 2 }, // 黄 -> in_progress
          ],
        },
        {
          r: 9,
          cells: [
            { col: 1, v: 'P2' },
            { col: 2, v: '30:00 - 60:00' },
            { col: 3, v: '官中', s: 0 }, // 精确 na 词表
            // C4 空白且未合并 -> 绝不被污染
          ],
        },
      ],
      merges: ['H6:H6'],
    },
    {
      name: '切片熟肉',
      fileNum: 3,
      rows: [
        { r: 1, cells: [{ col: 1, v: '注：' }] },
        {
          r: 2,
          cells: [
            { col: 1, v: '标题' },
            { col: 2, v: '时长' },
          ],
        },
        {
          r: 3,
          cells: [
            { col: 1, v: '示例GPT切片' },
            { col: 2, v: '01:25' },
            { col: 4, v: 'tyb0v1', s: 1 }, // 合并为 tyb0v0
            { col: 5, v: 'GPT', s: 1 }, // 纯文本负责人，不建用户
            { col: 12, v: '原视频', hl: 'https://example.test/video/1' },
          ],
        },
        {
          r: 4,
          cells: [
            { col: 1, v: '示例进行中切片' },
            { col: 5, v: '进行中', s: 2 },
            { col: 7, v: '扣下当校对题', s: 0 },
          ],
        },
      ],
    },
    {
      name: '广播剧',
      fileNum: 5,
      state: 'hidden',
      rows: [
        { r: 1, cells: [{ col: 1, v: '注：' }] },
        {
          r: 2,
          cells: [
            { col: 1, v: '标题' },
            { col: 2, v: '时长' },
            { col: 3, v: '出处' },
          ],
        },
        {
          r: 3,
          cells: [
            { col: 1, v: '示例广播剧一', s: 1 },
            { col: 2, v: 0.46875, s: 8 }, // h:mm -> 11:15，绝不误判为日期！
            { col: 3, v: '十单特典', s: 1 },
            { col: 4, v: '糖果', s: 1 }, // 合并为 辣味糖果
            { col: 5, v: 'uz(日文)', s: 1 }, // 合并为 uz + 备注 日文
            { col: 9, v: '2025.06..22', s: 1 }, // 纠错双点日期 -> 2025-06-22
          ],
        },
        {
          r: 4,
          cells: [
            { col: 1, v: '示例广播剧二', s: 1 },
            { col: 2, v: 0.5, s: 8 }, // 12:00
            // C3 合并继承「十单特典」
            { col: 4, v: '辣味糖果', s: 1 },
            { col: 5, v: '斗笠', s: 1 },
          ],
        },
      ],
      merges: ['C3:C4'],
    },
    {
      name: '杂志',
      fileNum: 6,
      rows: [
        {
          r: 1,
          cells: [
            { col: 1, v: '发布日期' },
            { col: 2, v: '杂志期刊' },
          ],
        },
        { r: 2, cells: [{ col: 2, v: '注：' }] },
        { r: 3, cells: [{ col: 3, v: '需要图源联系' }] },
        // 垃圾行必须跳过
        {
          r: 4,
          cells: [
            { col: 1, v: '2024.01.15', s: 1 },
            { col: 6, v: '刺刺广播 #2', s: 1 },
          ],
        },
        // A-I 绿但 J 黄 -> unpublished + 备注
        {
          r: 5,
          cells: [
            { col: 1, v: '2025.10.03', s: 1 },
            { col: 2, v: '剧场版总集篇场刊·前篇', s: 1 },
            { col: 3, v: 'Asama', s: 1 },
            { col: 4, s: 1 },
            { col: 5, s: 1 },
            { col: 6, v: '前篇访谈', s: 1 },
            { col: 7, s: 1 },
            { col: 8, s: 1 },
            { col: 9, s: 1 },
            { col: 10, s: 2 }, // J 黄
          ],
        },
      ],
    },
    {
      name: '漫画',
      fileNum: 4,
      rows: [
        { r: 1, cells: [{ col: 1, v: '发布日期' }] },
        { r: 2, cells: [{ col: 1, v: '注：' }] },
        { r: 3, hidden: true, cells: [{ col: 4, v: '刺刺广播 #3' }] }, // 垃圾行跳过
        {
          r: 4,
          cells: [
            { col: 1, v: '2024.08.12', s: 3 },
            { col: 2, v: '示例画集原名', s: 3 },
            { col: 4, v: '示例画集', s: 3 },
            { col: 11, v: '1zero', s: 3 }, // 蓝底 -> in_progress
          ],
        },
        { r: 19, cells: [{ col: 1, v: '漫画发布注意事项' }] },
        {
          r: 22,
          cells: [
            { col: 1, v: '示例短漫', s: 1 },
            { col: 2, v: '二狗（校对：斗笠）', s: 1 },
            { col: 3, v: '1zero', s: 1 },
            { col: 4, v: '网络', s: 1 },
          ],
        },
      ],
    },
    {
      name: '⭐翻译对照表⭐',
      fileNum: 1,
      rows: [
        {
          r: 1,
          cells: [
            { col: 1, v: '通用日语' },
            { col: 6, v: '剧中成员名（日文）' },
            { col: 12, v: '广播用' },
            { col: 17, v: '日文' },
          ],
        },
        {
          r: 2,
          cells: [
            { col: 1, v: 'トゲナシトゲアリ' },
            { col: 2, v: '无刺有刺' },
            { col: 3, v: '乐队名' },
            { col: 6, v: '井芹仁菜' },
            { col: 7, v: '井芹仁菜' },
            { col: 8, v: '理名' },
            { col: 9, v: '主唱' },
            { col: 10, v: '乐队：无刺有刺' },
            { col: 12, v: '青春相談所' },
            { col: 13, v: '「青春咨询所」' },
            { col: 15, v: '多行注释1\r\n多行注释2' },
            { col: 17, v: '企画' },
            { col: 18, v: '策划' },
          ],
        },
      ],
    },
    {
      name: '相关收益',
      fileNum: 2,
      rows: [
        { r: 1, cells: [{ col: 1, v: '财务联络提示' }] },
        { r: 4, cells: [{ col: 1, v: '提现金额' }] },
        {
          r: 5,
          hidden: true,
          cells: [
            { col: 1, v: 800 },
            { col: 4, v: 45937, s: 7 }, // 2025-10-07
            { col: 13, v: '第一行支出\r\n第二行说明' },
            { col: 14, v: 800 },
          ],
        },
      ],
    },
    {
      name: '动漫工作表（留念用）',
      fileNum: 8,
      state: 'hidden',
      rows: [
        { r: 1, cells: [{ col: 1, v: '话数' }] },
        { r: 2, cells: [{ col: 3, v: '1/5' }] },
        {
          r: 4,
          cells: [
            { col: 1, v: '第一话' },
            { col: 2, v: 45937, s: 7 },
            { col: 3, v: '帕鲁' }, // 留念表别名 -> 合并为 外协机械帕鲁 并预创建待认领用户
            { col: 17, v: '伟大，无需重制' },
          ],
        },
      ],
    },
  ];

  // 构建共享字符串表
  const sst: string[] = [];
  const sstMap = new Map<string, number>();
  const addSst = (s: string): number => {
    const existing = sstMap.get(s);
    if (existing !== undefined) return existing;
    const idx = sst.length;
    sst.push(s);
    sstMap.set(s, idx);
    return idx;
  };

  const files: Record<string, Uint8Array> = {};
  const wbSheetNodes: string[] = [];
  const wbRelNodes: string[] = [];

  for (let i = 0; i < sheets.length; i++) {
    const sh = sheets[i]!;
    const rId = `rId${i + 10}`;
    const stateAttr = sh.state === 'hidden' ? ' state="hidden"' : '';
    wbSheetNodes.push(
      `<sheet name="${xmlEscape(sh.name)}" sheetId="${i + 1}"${stateAttr} r:id="${rId}"/>`,
    );
    wbRelNodes.push(
      `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sh.fileNum}.xml"/>`,
    );

    const hlRels: string[] = [];
    const hlNodes: string[] = [];
    const rowXmls: string[] = [];

    for (const row of sh.rows) {
      const cellXmls: string[] = [];
      for (const c of row.cells) {
        const ref = `${colIndexToLetters(c.col)}${row.r}`;
        const sAttr = c.s !== undefined ? ` s="${c.s}"` : '';
        if (c.hl) {
          const hlId = `rIdHl${hlRels.length + 1}`;
          hlRels.push(
            `<Relationship Id="${hlId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(c.hl)}" TargetMode="External"/>`,
          );
          hlNodes.push(`<hyperlink ref="${ref}" r:id="${hlId}"/>`);
        }
        if (typeof c.v === 'string') {
          const idx = addSst(c.v);
          cellXmls.push(`<c r="${ref}" t="s"${sAttr}><v>${idx}</v></c>`);
        } else if (typeof c.v === 'number') {
          cellXmls.push(`<c r="${ref}"${sAttr}><v>${c.v}</v></c>`);
        } else {
          cellXmls.push(`<c r="${ref}"${sAttr}/>`);
        }
      }
      const hiddenAttr = row.hidden ? ' hidden="1"' : '';
      rowXmls.push(`<row r="${row.r}"${hiddenAttr}>${cellXmls.join('')}</row>`);
    }

    const mergeXml =
      sh.merges && sh.merges.length > 0
        ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
        : '';
    const hlXml = hlNodes.length > 0 ? `<hyperlinks>${hlNodes.join('')}</hyperlinks>` : '';

    files[`xl/worksheets/sheet${sh.fileNum}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetData>${rowXmls.join('')}</sheetData>
  ${mergeXml}
  ${hlXml}
</worksheet>`,
    );

    if (hlRels.length > 0) {
      files[`xl/worksheets/_rels/sheet${sh.fileNum}.xml.rels`] = strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${hlRels.join('')}</Relationships>`,
      );
    }
  }

  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${wbSheetNodes.join('')}</sheets>
</workbook>`,
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wbRelNodes.join('')}</Relationships>`,
  );
  files['xl/sharedStrings.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">${sst.map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`).join('')}</sst>`,
  );
  files['xl/styles.xml'] = strToU8(buildStylesXml());
  files['xl/theme/theme1.xml'] = strToU8(buildThemeXml());

  return zipSync(files);
}
