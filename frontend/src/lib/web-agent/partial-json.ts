// 从「还没传完」的工具参数 JSON 里增量抽取字符串字段。
//
// 为什么需要这个：原生 function calling 的编辑内容是以 JSON 字符串形式流式到达的
// （response.function_call_arguments.delta），而「网页复刻流」面板要实时显示正在写入的
// 代码。JSON.parse 在流结束前永远失败，所以这里做一个只认字符串字段的最小扫描器。
//
// 它不是通用 JSON 解析器：只负责在任意前缀上尽力抽出已知 key 的字符串值，
// 抽不出来就返回目前能确定的部分，绝不抛异常——面板显示不该拖垮 agent 循环。

interface DecodedString {
  value: string;
  /** 闭合引号之后的下标；未闭合时为 src.length */
  end: number;
  complete: boolean;
}

/** 从 start（指向开引号）开始解码一个 JSON 字符串字面量，处理全部转义。 */
function decodeJsonStringAt(src: string, start: number): DecodedString {
  let out = '';
  let i = start + 1;

  while (i < src.length) {
    const ch = src[i];

    if (ch === '\\') {
      // 悬空反斜杠：转义序列被切断了，丢掉它，下一个增量会补齐
      if (i + 1 >= src.length) return { value: out, end: src.length, complete: false };
      const esc = src[i + 1];
      switch (esc) {
        case 'n': out += '\n'; i += 2; break;
        case 't': out += '\t'; i += 2; break;
        case 'r': out += '\r'; i += 2; break;
        case 'b': out += '\b'; i += 2; break;
        case 'f': out += '\f'; i += 2; break;
        case '"': out += '"'; i += 2; break;
        case '\\': out += '\\'; i += 2; break;
        case '/': out += '/'; i += 2; break;
        case 'u': {
          const hex = src.slice(i + 2, i + 6);
          // \u 只到一半：同样丢弃，等下个增量
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { value: out, end: src.length, complete: false };
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          break;
        }
        default:
          out += esc;
          i += 2;
          break;
      }
      continue;
    }

    if (ch === '"') return { value: out, end: i + 1, complete: true };

    out += ch;
    i += 1;
  }

  return { value: out, end: src.length, complete: false };
}

export interface ScannedField {
  key: string;
  value: string;
  complete: boolean;
}

/**
 * 扫描出所有「字符串键 → 字符串值」对，包含最后一个未闭合的值。
 *
 * 判定方式：一个完整字符串后面第一个非空白字符是 `:` 就是键，否则是值。
 * 键之后若紧跟非字符串（数字、对象、数组），pendingKey 立即清空，
 * 避免把后面某个不相干的字符串错认成它的值。
 */
export function scanJsonStringFields(json: string): ScannedField[] {
  const src = String(json ?? '');
  const out: ScannedField[] = [];
  let pendingKey: string | null = null;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
      i += 1;
      continue;
    }

    if (ch === '"') {
      const decoded = decodeJsonStringAt(src, i);

      if (!decoded.complete) {
        // 未闭合的串：只有在它确实是某个键的值时才有意义（否则可能是正在传输的键名）
        if (pendingKey !== null) {
          out.push({ key: pendingKey, value: decoded.value, complete: false });
        }
        break;
      }

      let j = decoded.end;
      while (j < src.length && /\s/.test(src[j])) j += 1;

      if (src[j] === ':') {
        pendingKey = decoded.value;
        i = j + 1;
        continue;
      }

      if (pendingKey !== null) {
        out.push({ key: pendingKey, value: decoded.value, complete: true });
        pendingKey = null;
      }
      i = decoded.end;
      continue;
    }

    // 任何非字符串 token 出现，说明当前键的值不是字符串
    pendingKey = null;
    i += 1;
  }

  return out;
}

/**
 * 抽出 edit_file 参数里全部 content 字段并拼接，用于流式代码面板。
 * 多段编辑之间用空行分隔，面板上能看出这是分开的几处改动。
 */
export function extractStreamingEditContent(argsJson: string): string {
  const chunks = scanJsonStringFields(argsJson)
    .filter((field) => field.key === 'content')
    .map((field) => field.value);
  return chunks.join('\n\n');
}

/** 抽出 path 字段，用于「正在编辑 xxx」的标签。只认已闭合的值。 */
export function extractStreamingPath(argsJson: string): string | null {
  const found = scanJsonStringFields(argsJson).find(
    (field) => field.key === 'path' && field.complete,
  );
  return found ? found.value : null;
}
