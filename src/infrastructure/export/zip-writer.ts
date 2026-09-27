/**
 * v2.2.0 最小 ZIP 写入器（TASK §26/§27）。
 *
 * DOCX 与 EPUB 都是 ZIP 容器。这里自己写一个 STORED（不压缩）条目版，
 * 而不是引一个压缩库，理由有三条：
 *   1. 短篇故事的体积根本不值得压缩，STORED 条目是标准 ZIP，Word 与阅读器都认；
 *   2. EPUB 规范**要求** mimetype 必须是第一个条目且不许压缩——STORED 天然满足，
 *      不用为了合规去研究压缩库怎么逐条关掉 deflate；
 *   3. 少一个运行时依赖，就少一整条供应链面。这个文件只做 CRC32 + 固定头，
 *      行数可控、可以逐字节测。
 *
 * 确定性：时间戳固定取 1980-01-01（ZIP 的 DOS 时间戳下界），同一份输入永远产出
 * 同一串字节。导出不该因为「今天是几号」而每次不同——测试要能逐字节比对，
 * 用户重复导出同一篇也该得到可比对的结果。
 */

/** DOS 时间戳下界：1980-01-01 00:00:00。 */
const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01 → ((1980-1980)<<9) | (1<<5) | 1

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/** UTF-8 文件名标志位（APPNOTE 4.4.4）。不置位的话非 ASCII 条目名会被读成 GBK。 */
const UTF8_FLAG = 0x0800;

export interface ZipEntry {
  /** 压缩包内的路径，正斜杠分隔。 */
  name: string;
  /** 条目内容。字符串按 UTF-8 编码。 */
  data: Uint8Array | string;
  /** 需要这个条目保持 STORED 时置位（EPUB 的 mimetype）；本写入器全部条目都是 STORED。 */
  stored?: boolean;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32（IEEE 802.3，ZIP 用的那一种）。 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

function bytesOf(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? encoder.encode(value) : value;
}

class ByteWriter {
  private chunks: Uint8Array[] = [];
  length = 0;

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  u16(value: number): void {
    this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  }

  u32(value: number): void {
    this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]));
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/**
 * 组装一个 ZIP。条目顺序即为写入顺序——调用方要把 mimetype 放第一位时，
 * 就把它放在数组第一位（EPUB 规范的要求）。
 */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const body = new ByteWriter();
  const central = new ByteWriter();
  const offsets: number[] = [];

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = bytesOf(entry.data);
    const crc = crc32(data);
    offsets.push(body.length);

    // —— 本地文件头 ——
    body.u32(LOCAL_HEADER_SIG);
    body.u16(20); // 所需版本：2.0
    body.u16(UTF8_FLAG);
    body.u16(0); // 压缩方法：STORED
    body.u16(DOS_TIME);
    body.u16(DOS_DATE);
    body.u32(crc);
    body.u32(data.length); // 压缩后大小
    body.u32(data.length); // 未压缩大小
    body.u16(nameBytes.length);
    body.u16(0); // 额外字段长度
    body.push(nameBytes);
    body.push(data);

    // —— 中央目录记录 ——
    central.u32(CENTRAL_HEADER_SIG);
    central.u16(20); // 制作版本
    central.u16(20); // 所需版本
    central.u16(UTF8_FLAG);
    central.u16(0);
    central.u16(DOS_TIME);
    central.u16(DOS_DATE);
    central.u32(crc);
    central.u32(data.length);
    central.u32(data.length);
    central.u16(nameBytes.length);
    central.u16(0); // 额外字段
    central.u16(0); // 注释
    central.u16(0); // 磁盘号
    central.u16(0); // 内部属性
    central.u32(0); // 外部属性
    central.u32(offsets[offsets.length - 1]);
    central.push(nameBytes);
  }

  const out = new ByteWriter();
  out.push(body.toUint8Array());
  const centralBytes = central.toUint8Array();
  const centralOffset = out.length;
  out.push(centralBytes);

  // —— 末尾目录（EOCD）——
  out.u32(EOCD_SIG);
  out.u16(0); // 磁盘号
  out.u16(0); // 中央目录起始磁盘
  out.u16(entries.length);
  out.u16(entries.length);
  out.u32(centralBytes.length);
  out.u32(centralOffset);
  out.u16(0); // 注释长度
  return out.toUint8Array();
}
