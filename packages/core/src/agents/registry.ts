/**
 * Versioned skill registry. Every button, slash command and schedule resolves to one entry
 * here; there is exactly one implementation of each flow. `status` is the real product
 * state, shown in the UI and FEATURE-MAP — never "ready" for an unwired skill.
 */
export type SkillMode = 'read' | 'propose' | 'deterministic';
export type SkillStatus = 'implemented' | 'deterministic' | 'not_implemented';

export interface SkillDef {
  id: string;
  version: string;
  upstreamFile: string;
  title: string;
  mode: SkillMode;
  tools: string[];
  status: SkillStatus;
  runKind?: 'ingest' | 'query' | 'studio' | 'quiz';
  limits: { maxTurns: number; timeoutS: number };
  inputSchema: Record<string, unknown>;
  note?: string;
}

const READ_TOOLS = ['search_wiki', 'read_note', 'get_backlinks'];

export const SKILLS: SkillDef[] = [
  { id: 'ingest', version: '1.0.0', upstreamFile: 'skills/second-brain-ingest/SKILL.md', title: 'ورود منبع به ویکی', mode: 'propose', tools: ['read_source', ...READ_TOOLS, 'propose_change'], status: 'implemented', runKind: 'ingest', limits: { maxTurns: 30, timeoutS: 600 }, inputSchema: { sourceId: 'uuid' } },
  { id: 'query', version: '1.0.0', upstreamFile: 'skills/second-brain-query/SKILL.md', title: 'پرسش مستند', mode: 'read', tools: READ_TOOLS, status: 'implemented', runKind: 'query', limits: { maxTurns: 16, timeoutS: 300 }, inputSchema: { question: 'string', scope: 'scope' } },
  { id: 'report', version: '1.0.0', upstreamFile: 'skills/second-brain-report/SKILL.md', title: 'گزارش پژوهشی', mode: 'read', tools: READ_TOOLS, status: 'implemented', runKind: 'studio', limits: { maxTurns: 24, timeoutS: 600 }, inputSchema: { outputId: 'uuid' } },
  { id: 'write', version: '1.0.0', upstreamFile: 'skills/second-brain-write/SKILL.md', title: 'پیش‌نویس از دانش', mode: 'read', tools: READ_TOOLS, status: 'implemented', runKind: 'studio', limits: { maxTurns: 24, timeoutS: 600 }, inputSchema: { outputId: 'uuid' } },
  { id: 'quiz', version: '1.0.0', upstreamFile: 'skills/second-brain-quiz/SKILL.md', title: 'آزمون یادگیری', mode: 'read', tools: READ_TOOLS, status: 'implemented', runKind: 'quiz', limits: { maxTurns: 12, timeoutS: 300 }, inputSchema: { documentIds: 'uuid[]' } },
  { id: 'chat-import', version: '1.0.0', upstreamFile: 'skills/second-brain-chat-import/SKILL.md', title: 'ورود گفتگوهای خروجی‌گرفته', mode: 'deterministic', tools: [], status: 'deterministic', limits: { maxTurns: 0, timeoutS: 120 }, inputSchema: { file: 'json' }, note: 'parser قطعی (chat_messages/mapping/messages)؛ هر گفتگو یک منبع جدا که ingest جدا می‌خواهد.' },
  { id: 'transcript', version: '1.0.0', upstreamFile: 'skills/second-brain-transcript/SKILL.md', title: 'transcript صوت/ویدئو', mode: 'deterministic', tools: [], status: 'deterministic', limits: { maxTurns: 0, timeoutS: 60 }, inputSchema: { text: 'string' }, note: 'فقط متن transcript آماده (VTT/SRT/TXT) پذیرفته می‌شود؛ تبدیل صوت فعال نیست.' },
  { id: 'lint', version: '1.0.0', upstreamFile: 'skills/second-brain-lint/SKILL.md', title: 'سلامت ساختاری', mode: 'deterministic', tools: [], status: 'deterministic', limits: { maxTurns: 0, timeoutS: 60 }, inputSchema: {}, note: 'لینک شکسته، صفحهٔ یتیم، frontmatter نامعتبر، ابهام نام — با کد قطعی؛ رفع خودکار ندارد.' },
  { id: 'graph', version: '1.0.0', upstreamFile: 'skills/second-brain-graph/SKILL.md', title: 'تحلیل گراف', mode: 'deterministic', tools: [], status: 'deterministic', limits: { maxTurns: 0, timeoutS: 60 }, inputSchema: {}, note: 'درجه، یتیم‌ها، مؤلفه‌ها و hubها از لینک‌های resolveشده.' },
  { id: 'metrics', version: '1.0.0', upstreamFile: 'skills/second-brain-metrics/SKILL.md', title: 'شاخص‌های سلامت', mode: 'deterministic', tools: [], status: 'deterministic', limits: { maxTurns: 0, timeoutS: 60 }, inputSchema: {} },
  { id: 'project', version: '1.0.0', upstreamFile: 'skills/second-brain-project/SKILL.md', title: 'پروژه', mode: 'deterministic', tools: [], status: 'deterministic', limits: { maxTurns: 0, timeoutS: 30 }, inputSchema: {}, note: 'چهار بخش Inputs/Process/Outputs/Feedback در DB؛ بدون عامل.' },
  { id: 'privacy', version: '1.0.0', upstreamFile: 'skills/second-brain-privacy/SKILL.md', title: 'حریم خصوصی', mode: 'deterministic', tools: [], status: 'deterministic', limits: { maxTurns: 0, timeoutS: 60 }, inputSchema: {}, note: 'برچسب حساسیت سمت سرور و حذف آگاهانهٔ مالک؛ اسکن secret الگو-محور.' },
  { id: 'rename', version: '1.0.0', upstreamFile: 'skills/second-brain-rename/SKILL.md', title: 'تغییرنام امن', mode: 'deterministic', tools: [], status: 'not_implemented', limits: { maxTurns: 0, timeoutS: 60 }, inputSchema: { documentId: 'uuid', newTitle: 'string' }, note: 'ChangeSet قطعی: فایل + همهٔ لینک‌های ورودی + alias قدیمی.' },
  { id: 'review', version: '1.0.0', upstreamFile: 'skills/second-brain-review/SKILL.md', title: 'مرور دوره‌ای', mode: 'read', tools: READ_TOOLS, status: 'not_implemented', limits: { maxTurns: 16, timeoutS: 300 }, inputSchema: {} },
  { id: 'merge', version: '1.0.0', upstreamFile: 'skills/second-brain-merge/SKILL.md', title: 'ادغام صفحات', mode: 'propose', tools: READ_TOOLS, status: 'not_implemented', limits: { maxTurns: 16, timeoutS: 300 }, inputSchema: {} },
  { id: 'backfill', version: '1.0.0', upstreamFile: 'skills/second-brain-backfill/SKILL.md', title: 'ورود دسته‌ای آرشیو', mode: 'propose', tools: [], status: 'not_implemented', limits: { maxTurns: 0, timeoutS: 0 }, inputSchema: {} },
  { id: 'publish', version: '1.0.0', upstreamFile: 'skills/second-brain-publish/SKILL.md', title: 'انتشار', mode: 'read', tools: [], status: 'not_implemented', limits: { maxTurns: 0, timeoutS: 0 }, inputSchema: {}, note: 'انتشار بیرونی نیازمند consent جداست و در نسخهٔ ۱ نیست.' },
  { id: 'changed-my-mind', version: '1.0.0', upstreamFile: 'skills/second-brain-changed-my-mind/SKILL.md', title: 'ردیابی تغییر نظر', mode: 'read', tools: READ_TOOLS, status: 'not_implemented', limits: { maxTurns: 16, timeoutS: 300 }, inputSchema: {} },
];

export const skillById = (id: string) => SKILLS.find(s => s.id === id);
