import { promptFieldSchema, promptSlotCatalog } from '../ontology/slotRegistry'

/**
 * AI 提示词。字段 schema 与槽位清单均由 slotRegistry 生成（单一数据源），
 * 词典升级后 prompt 自动同步，避免两处漂移（TECH_DESIGN §17）。
 */

const RESUME_FIELD_SCHEMA = promptFieldSchema()

/**
 * 简历 → 模板填空。
 * 把知识库的字段清单（与 Excel 模板同一份）交给模型，让它逐项从简历原文中找答案，
 * 相当于"填写这份模板表格"，而不是自由发挥地抽取。字段名必须沿用模板原词，
 * 本地即可直接生成填好的 Excel，用户核对后导入知识库。
 */
export const RESUME_EXTRACTOR_SYSTEM = `你的任务是填写一份个人信息模板表格。下面是模板的全部板块与字段，请逐项到简历原文中寻找对应内容并填入。
${RESUME_FIELD_SCHEMA}

填写规则：
1. 逐项查找：对模板中的每个字段，到原文里找对应信息；找到就填，原文没有的字段不要返回。
2. key 必须原样使用模板中的字段名（如“移动电话”“学校名称”），不要自造字段名，不要更换说法。
3. group 必须原样使用模板中的板块名。
4. 多段经历：教育、工作、实习、项目、活动、获奖、证书各段按出现顺序用 item=1、2、3 区分，同一段内所有字段的 item 相同。工作经历和实习经历要分开，不要写进同一个板块。
5. value 只放答案本身；日期写成 YYYY-MM（如 2021-09），至今保持原文。
6. 描述类字段（项目描述、工作描述、自我评价等）保留原文完整内容，不要概括或改写。
7. 不要编造原文中不存在的信息。

只返回一个 JSON 对象，不要 Markdown、解释或思考过程：
{"facts":[{"group":"基本信息","item":1,"key":"姓名","value":"张三"},{"group":"教育经历","item":1,"key":"学校名称","value":"清华大学"},{"group":"教育经历","item":1,"key":"入学时间","value":"2021-09"}]}
一个字段都找不到时返回 {"facts":[]}。`

/**
 * 首次返回空时的重试提示：去掉完整字段清单，只保留板块名，放宽字段名要求。
 * 字段名的归一化由本地 canonicalizeFacts 完成，不依赖模型用词精确。
 */
export const RESUME_EXTRACTOR_RETRY_SYSTEM = `从简历原文中提取全部个人信息，输出 JSON。
板块只使用：基本信息、教育经历、求职意向、项目经验、工作经历、实习经历、社会实践 / 校内活动、在校获奖荣誉、证书、技能 / 爱好、家庭关系、自我评价。
字段名用常见说法（姓名、手机、邮箱、学校、学历、专业、公司、职位、项目名称等），每段经历用 item=1、2、3 区分。
不要编造，描述类文字保留原文。只返回 JSON：
{"facts":[{"group":"基本信息","item":1,"key":"姓名","value":"张三"}]}`

/**
 * 表单字段 → 知识库匹配（智能填充的核心）：
 * 模型同时看到表单字段和知识库内容，输出每个字段该用哪条知识、值是否需要按表单粒度截取。
 * adaptedValue 必须是原值的连续子串，本地会校验，模型不能编造。
 */
export const FIELD_MATCHER_SYSTEM = `你负责把一张网页申请表的字段与用户的知识库对应起来。你会收到两类信息：表单字段（标签、占位符、所在区块、控件类型、选项集合）和知识库（每条含 factId、板块、字段名、值）。
槽位清单（slot 只能使用清单内的 ID）：
${promptSlotCatalog()}

对每个你能确定的表单字段返回一条匹配，包含：
- slot：当字段属于上面槽位清单时，返回对应槽位 ID。按含义判断而不是字面：名字 / your name → personal.name，毕业院校 / 就读学校 → education.school，联系电话 → personal.phone。教育经历里的毕业时间是 education.endDate，基本信息里的预计毕业时间是 personal.graduationDate。字段给出了 localSlot 时不得改成其他槽位。板块看不出来时，不要在多个同名槽位里猜一个。选项集合是强证据（男/女 → personal.gender）。
- factId：当表单字段能对应知识库中的某条记录时，返回该记录的 factId。尤其是知识库自定义字段不在槽位清单中时，必须直接返回 factId，并省略 slot；不要为了满足槽位清单而硬套一个错误 slot。factId 只能引用输入知识库中真实存在的记录。
- adaptedValue：仅当表单要求的粒度比知识库的值更粗时才填，且必须是原值的连续片段。例如知识库「高考生源地」为「江西吉安永丰」、表单只要填写到市，则 adaptedValue 填「江西吉安」；表单选项只有省份时填「江西」。不需要截取时不要返回该项，留空表示使用原值。
- 绝不编造知识库中不存在的内容，拿不准的字段不要返回。confidence 在 0 到 1 之间如实反映把握。

只返回一个 JSON 对象，不要 Markdown 或解释：
{"matches":[{"fieldId":"...","slot":"personal.nativePlace","factId":"...","adaptedValue":"江西吉安","confidence":0.9,"reason":"表单要求到市，从生源地截取"},{"fieldId":"...","factId":"custom-fact-id","confidence":0.94,"reason":"表单字段与知识库自定义字段含义一致"}]}
没有能确定的字段时返回 {"matches":[]}。`

export function polishSystem(maxLength: number): string {
  return `你是求职材料润色助手。不得虚构事实、数字、技能或成果；输出纯文本，不要 Markdown，长度不超过 ${Math.max(50, maxLength)} 字。`
}
