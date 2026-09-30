import type { SectionId, SlotDef } from '../../domain/slots'
import { normalize } from '../../shared/normalize'
import { DEGREE_LADDER } from './synonyms'
import { SECTIONS, sectionLabel } from './sections'

/**
 * 槽位定义总表（F01，单一数据源）。
 *
 * - 替换 fieldMapper.semanticPatterns 与 factPriority.keySlot 两套旧词典。
 * - AI 抽取 schema（prompts.RESUME_FIELD_SCHEMA）由本表生成，二者不再漂移。
 * - 槽位 ID 永不复用：站点规则与评测集都引用它。
 *
 * 词典升级时递增 SLOT_REGISTRY_VERSION，使 AI 匹配缓存自动失效（F43）。
 */

export const SLOT_REGISTRY_VERSION = 3

const DEGREE_ENUM = DEGREE_LADDER.slice(1) // 初中及以上

export const SLOTS: SlotDef[] = [
  // ─── 基本信息 ───────────────────────────────────────────────
  {
    id: 'personal.name', section: 'personal',
    aliases: ['姓名', '名字', '真实姓名', '申请人姓名', '中文姓名'],
    patterns: [/^姓\s*名$/, /^(name|full\s*name)$/i],
    attrAliases: ['fullname', 'realname', 'truename', 'username'],
    excludePatterns: [/紧急|联系人|证明人|家庭|成员|父亲|母亲|配偶|监护人|英文/],
    valueType: 'text', repeatable: false, sensitive: false, maxLengthHint: 30
  },
  {
    id: 'personal.idType', section: 'personal',
    aliases: ['证件类型'],
    enumValues: ['居民身份证', '护照', '港澳居民来往内地通行证', '台湾居民来往大陆通行证', '军官证', '其他'],
    valueType: 'enum', repeatable: false, sensitive: false
  },
  {
    id: 'personal.idNumber', section: 'personal',
    aliases: ['证件号码', '身份证号', '身份证号码', '证件号'],
    patterns: [/身份证.*号|证件.*号码/],
    attrAliases: ['idcard', 'idnumber', 'identity'],
    valueType: 'text', repeatable: false, sensitive: true, maxLengthHint: 18
  },
  {
    id: 'personal.gender', section: 'personal',
    aliases: ['性别'],
    patterns: [/^(gender|sex)$/i],
    attrAliases: ['gender', 'sex'],
    enumValues: ['男', '女'],
    valueType: 'enum', repeatable: false, sensitive: false
  },
  {
    id: 'personal.birthday', section: 'personal',
    aliases: ['出生日期', '出生年月', '生日'],
    patterns: [/date\s*of\s*birth|birthday|birth\s*date/i],
    attrAliases: ['birthday', 'birthdate', 'dateofbirth', 'dob'],
    valueType: 'date', repeatable: false, sensitive: false
  },
  {
    id: 'personal.ethnicity', section: 'personal',
    aliases: ['民族'],
    enumValues: ['汉族', '壮族', '满族', '回族', '苗族', '维吾尔族', '土家族', '彝族', '蒙古族', '藏族', '布依族', '侗族', '瑶族', '朝鲜族', '白族', '哈尼族', '哈萨克族', '黎族', '傣族'],
    valueType: 'text', repeatable: false, sensitive: false
  },
  {
    id: 'personal.politicalStatus', section: 'personal',
    aliases: ['政治面貌'],
    enumValues: ['中共党员', '中共预备党员', '共青团员', '群众', '民主党派'],
    valueType: 'enum', repeatable: false, sensitive: false
  },
  {
    id: 'personal.nativePlace', section: 'personal',
    aliases: ['籍贯'],
    excludePatterns: [/户口|户籍|居住|生源/],
    valueType: 'text', repeatable: false, sensitive: false
  },
  {
    id: 'personal.health', section: 'personal',
    aliases: ['健康状况', '健康情况', '身体状况'],
    enumValues: ['健康', '良好', '一般'],
    valueType: 'text', repeatable: false, sensitive: false
  },
  {
    id: 'personal.gaokaoOrigin', section: 'personal',
    aliases: ['高考生源地', '生源地', '生源所在地'],
    valueType: 'text', repeatable: false, sensitive: false
  },
  {
    id: 'personal.householdLocation', section: 'personal',
    aliases: ['户口所在地', '户籍所在地', '户籍地', '户口'],
    excludePatterns: [/籍贯|居住|生源/],
    valueType: 'text', repeatable: false, sensitive: false
  },
  {
    id: 'personal.currentCity', section: 'personal',
    aliases: ['现居住城市', '现居住地', '现居地', '所在城市', '居住地', '现居城市', '目前所在地'],
    attrAliases: ['city', 'currentcity', 'location'],
    excludePatterns: [/通信|通讯|邮寄|户口|户籍|籍贯|院校|意向|期望|工作地/],
    valueType: 'text', repeatable: false, sensitive: false
  },
  {
    id: 'personal.schoolCity', section: 'personal',
    aliases: ['就读院校所在城市', '院校所在城市', '学校所在城市', '院校所在地'],
    valueType: 'text', repeatable: false, sensitive: false
  },
  {
    id: 'personal.isFreshGraduate', section: 'personal',
    aliases: ['是否为应届毕业生', '是否应届', '应届毕业生', '应届生'],
    valueType: 'boolean', repeatable: false, sensitive: false
  },
  {
    id: 'personal.graduationDate', section: 'personal',
    aliases: ['预计毕业时间', '预计毕业日期', '预计毕业年月'],
    legacyAliases: ['毕业时间', '毕业日期', '毕业年月'],
    valueType: 'month', repeatable: false, sensitive: false
  },
  {
    id: 'personal.acceptAdjustment', section: 'personal',
    aliases: ['是否接受岗位调剂', '是否服从调剂', '接受调剂'],
    valueType: 'boolean', repeatable: false, sensitive: false
  },
  {
    id: 'personal.phone', section: 'personal',
    aliases: ['移动电话', '手机', '手机号', '手机号码', '联系电话', '电话', '电话号码', '联系方式'],
    patterns: [/^(mobile|phone|tel|cell\s*phone)$/i],
    attrAliases: ['phone', 'mobile', 'tel', 'cellphone', 'telephone'],
    excludePatterns: [/紧急|联系人|证明人|家长|父|母|固定|单位电话|家庭电话/],
    valueType: 'phone', repeatable: false, sensitive: false, maxLengthHint: 11
  },
  {
    id: 'personal.email', section: 'personal',
    aliases: ['电子邮箱', '邮箱', '电子邮件', '邮箱地址'],
    patterns: [/e-?mail/i],
    attrAliases: ['email', 'mail'],
    valueType: 'email', repeatable: false, sensitive: false
  },
  {
    id: 'personal.postalAddress', section: 'personal',
    aliases: ['通信地址', '通讯地址', '邮寄地址', '联系地址', '详细地址', '家庭住址'],
    attrAliases: ['address'],
    excludePatterns: [/邮政编码|邮编/],
    valueType: 'text', repeatable: false, sensitive: false
  },
  {
    id: 'personal.emergencyName', section: 'personal',
    aliases: ['紧急联系人姓名', '紧急联系人'],
    patterns: [/紧急.*(姓名|联系人)(?!.*(电话|方式|号码))/],
    valueType: 'text', repeatable: false, sensitive: true
  },
  {
    id: 'personal.emergencyPhone', section: 'personal',
    aliases: ['紧急联系方式', '紧急联系人电话', '紧急联系电话', '紧急联系人联系方式'],
    patterns: [/紧急.*(电话|方式|号码)/],
    valueType: 'phone', repeatable: false, sensitive: true
  },
  {
    id: 'personal.referralCode', section: 'personal',
    aliases: ['内推码', '推荐码', '内推人码'],
    attrAliases: ['referral', 'refcode'],
    valueType: 'text', repeatable: false, sensitive: false
  },
  {
    id: 'personal.highestDegree', section: 'personal',
    aliases: ['最高学历'],
    patterns: [/最高.{0,2}学历/],
    enumValues: DEGREE_ENUM,
    valueType: 'enum', repeatable: false, sensitive: false
  },

  // ─── 教育经历（可重复）─────────────────────────────────────
  {
    id: 'education.startDate', section: 'education',
    aliases: ['入学时间', '入学日期', '入学年月'],
    patterns: [/开始时间|起始时间/],
    valueType: 'month', repeatable: true, sensitive: false
  },
  {
    id: 'education.endDate', section: 'education',
    aliases: ['毕业时间', '毕业日期', '毕业年月'],
    patterns: [/结束时间|终止时间/],
    valueType: 'month', repeatable: true, sensitive: false
  },
  {
    id: 'education.school', section: 'education',
    aliases: ['学校名称', '学校', '毕业院校', '院校', '毕业学校', '院校名称', '大学'],
    patterns: [/^(school|university|college)/i, /毕业院校名称/],
    attrAliases: ['school', 'university', 'college'],
    valueType: 'text', repeatable: true, sensitive: false
  },
  {
    id: 'education.degree', section: 'education',
    aliases: ['学历'],
    patterns: [/^(education\s*level|degree)$/i],
    attrAliases: ['degree', 'education'],
    excludePatterns: [/最高|学位|受教育类型/],
    enumValues: DEGREE_ENUM,
    valueType: 'enum', repeatable: true, sensitive: false
  },
  {
    id: 'education.academicDegree', section: 'education',
    aliases: ['学位', '学位名称'],
    excludePatterns: [/学历/],
    enumValues: ['学士', '硕士', '博士'],
    valueType: 'enum', repeatable: true, sensitive: false
  },
  {
    id: 'education.duration', section: 'education',
    aliases: ['学制'],
    valueType: 'text', repeatable: true, sensitive: false
  },
  {
    id: 'education.educationType', section: 'education',
    aliases: ['受教育类型', '培养方式', '教育类型', '就读方式'],
    enumValues: ['全日制', '非全日制', '自考', '成人教育'],
    valueType: 'text', repeatable: true, sensitive: false
  },
  {
    id: 'education.faculty', section: 'education',
    aliases: ['院系', '学院', '系别', '院系名称'],
    excludePatterns: [/院校|学校/],
    valueType: 'text', repeatable: true, sensitive: false
  },
  {
    id: 'education.major', section: 'education',
    aliases: ['专业名称', '专业', '所学专业'],
    patterns: [/^major$/i],
    attrAliases: ['major'],
    excludePatterns: [/课程/],
    valueType: 'text', repeatable: true, sensitive: false
  },
  {
    id: 'education.courses', section: 'education',
    aliases: ['专业课程', '主修课程', '主要课程', '核心课程'],
    valueType: 'longtext', repeatable: true, sensitive: false
  },

  // ─── 求职意向 ───────────────────────────────────────────────
  {
    id: 'intention.expectedLocation', section: 'intention',
    aliases: ['期望工作地点', '期望城市', '意向城市', '期望工作城市', '意向工作地点', '期望工作地'],
    valueType: 'text', repeatable: false, sensitive: false
  },
  {
    id: 'intention.expectedSalary', section: 'intention',
    aliases: ['期望薪酬', '期望薪资', '期望月薪', '薪资要求'],
    valueType: 'text', repeatable: false, sensitive: false
  },
  {
    id: 'intention.availableDate', section: 'intention',
    aliases: ['到岗时间', '最快到岗时间', '可到岗时间'],
    valueType: 'text', repeatable: false, sensitive: false
  },
  {
    id: 'intention.jobNature', section: 'intention',
    aliases: ['期望工作性质', '工作性质'],
    enumValues: ['全职', '兼职', '实习'],
    valueType: 'enum', repeatable: false, sensitive: false
  },
  {
    id: 'intention.infoChannel', section: 'intention',
    aliases: ['了解该招聘信息渠道', '招聘信息来源', '信息来源', '信息渠道', '从何处得知'],
    valueType: 'text', repeatable: false, sensitive: false
  },

  // ─── 项目经验（可重复）─────────────────────────────────────
  {
    id: 'project.startDate', section: 'project',
    aliases: ['开始时间', '起始时间', '项目开始时间'],
    valueType: 'month', repeatable: true, sensitive: false
  },
  {
    id: 'project.endDate', section: 'project',
    aliases: ['结束时间', '终止时间', '项目结束时间'],
    valueType: 'month', repeatable: true, sensitive: false
  },
  {
    id: 'project.name', section: 'project',
    aliases: ['项目名称', '项目标题'],
    patterns: [/project\s*name/i],
    excludePatterns: [/公司|企业|活动|单位/],
    valueType: 'text', repeatable: true, sensitive: false
  },
  {
    id: 'project.role', section: 'project',
    aliases: ['项目职务', '项目角色', '担任角色', '项目职责角色'],
    valueType: 'text', repeatable: true, sensitive: false
  },
  {
    id: 'project.description', section: 'project',
    aliases: ['项目描述', '项目介绍', '项目内容', '项目职责'],
    valueType: 'longtext', repeatable: true, sensitive: false
  },

  // ─── 工作经历（可重复，与实习分开）─────────────────────────
  {
    id: 'work.startDate', section: 'work',
    aliases: ['开始时间', '入职时间', '起始时间'],
    valueType: 'month', repeatable: true, sensitive: false
  },
  {
    id: 'work.endDate', section: 'work',
    aliases: ['结束时间', '离职时间', '终止时间'],
    valueType: 'month', repeatable: true, sensitive: false
  },
  {
    id: 'work.company', section: 'work',
    aliases: ['企业名称', '公司名称', '公司', '单位名称', '工作单位', '单位', '雇主'],
    patterns: [/^(company|employer)/i],
    attrAliases: ['company', 'employer'],
    excludePatterns: [/家庭|父|母|成员|证明人|颁发|实习/],
    valueType: 'text', repeatable: true, sensitive: false
  },
  {
    id: 'work.position', section: 'work',
    aliases: ['职位名称', '职位', '岗位', '岗位名称', '职务', '担任职务'],
    patterns: [/^(position|job\s*title|role)$/i],
    attrAliases: ['position', 'jobtitle'],
    excludePatterns: [/项目|证明人|期望|意向|活动/],
    valueType: 'text', repeatable: true, sensitive: false
  },
  {
    id: 'work.description', section: 'work',
    aliases: ['工作描述', '工作内容', '工作职责', '主要职责', '主要工作', '经历描述', '职责描述'],
    valueType: 'longtext', repeatable: true, sensitive: false
  },

  // ─── 实习经历（可重复）─────────────────────────────────────
  {
    id: 'internship.startDate', section: 'internship',
    aliases: ['开始时间', '入职时间', '起始时间'],
    valueType: 'month', repeatable: true, sensitive: false
  },
  {
    id: 'internship.endDate', section: 'internship',
    aliases: ['结束时间', '离职时间', '终止时间'],
    valueType: 'month', repeatable: true, sensitive: false
  },
  {
    id: 'internship.company', section: 'internship',
    aliases: ['企业名称', '公司名称', '公司', '单位名称', '工作单位', '单位', '雇主', '实习单位'],
    patterns: [/^(company|employer)/i],
    attrAliases: ['company', 'employer'],
    excludePatterns: [/家庭|父|母|成员|证明人|颁发/],
    valueType: 'text', repeatable: true, sensitive: false
  },
  {
    id: 'internship.position', section: 'internship',
    aliases: ['职位名称', '职位', '岗位', '岗位名称', '职务', '担任职务'],
    patterns: [/^(position|job\s*title|role)$/i],
    attrAliases: ['position', 'jobtitle'],
    excludePatterns: [/项目|证明人|期望|意向|活动/],
    valueType: 'text', repeatable: true, sensitive: false
  },
  {
    id: 'internship.refereeName', section: 'internship',
    aliases: ['证明人姓名', '证明人'],
    patterns: [/证明人(?!.*(电话|方式|职务|号码))/],
    valueType: 'text', repeatable: true, sensitive: true
  },
  {
    id: 'internship.refereeTitle', section: 'internship',
    aliases: ['证明人职务'],
    valueType: 'text', repeatable: true, sensitive: false
  },
  {
    id: 'internship.refereePhone', section: 'internship',
    aliases: ['证明人联系方式', '证明人电话', '证明人联系电话'],
    patterns: [/证明人.*(电话|方式|号码)/],
    valueType: 'phone', repeatable: true, sensitive: true
  },
  {
    id: 'internship.description', section: 'internship',
    aliases: ['工作描述', '工作内容', '工作职责', '主要职责', '主要工作', '经历描述', '职责描述'],
    valueType: 'longtext', repeatable: true, sensitive: false
  },

  // ─── 社会实践 / 校内活动（可重复）─────────────────────────
  {
    id: 'campus.startDate', section: 'campus',
    aliases: ['开始时间', '起始时间'],
    valueType: 'month', repeatable: true, sensitive: false
  },
  {
    id: 'campus.endDate', section: 'campus',
    aliases: ['结束时间', '终止时间'],
    valueType: 'month', repeatable: true, sensitive: false
  },
  {
    id: 'campus.name', section: 'campus',
    aliases: ['活动名称', '实践名称', '社团名称'],
    valueType: 'text', repeatable: true, sensitive: false
  },
  {
    id: 'campus.description', section: 'campus',
    aliases: ['活动描述', '活动内容', '实践内容', '实践描述'],
    valueType: 'longtext', repeatable: true, sensitive: false
  },
  {
    id: 'campus.role', section: 'campus',
    aliases: ['职务', '担任职务', '活动职务'],
    excludePatterns: [/证明人|项目/],
    valueType: 'text', repeatable: true, sensitive: false
  },

  // ─── 在校获奖荣誉（可重复）─────────────────────────────────
  {
    id: 'award.category', section: 'award',
    aliases: ['奖项类别', '奖励类别', '获奖类别'],
    valueType: 'text', repeatable: true, sensitive: false
  },
  {
    id: 'award.name', section: 'award',
    aliases: ['奖励名称', '获奖名称', '奖项名称', '荣誉名称'],
    valueType: 'text', repeatable: true, sensitive: false
  },
  {
    id: 'award.level', section: 'award',
    aliases: ['奖励级别', '获奖级别', '奖项级别'],
    enumValues: ['国家级', '省级', '市级', '校级', '院级'],
    excludePatterns: [/等级/],
    valueType: 'text', repeatable: true, sensitive: false
  },
  {
    id: 'award.grade', section: 'award',
    aliases: ['奖励等级', '获奖等级'],
    enumValues: ['特等奖', '一等奖', '二等奖', '三等奖', '优秀奖'],
    excludePatterns: [/级别/],
    valueType: 'text', repeatable: true, sensitive: false
  },
  {
    id: 'award.date', section: 'award',
    aliases: ['获奖时间', '获奖日期', '颁奖时间'],
    valueType: 'month', repeatable: true, sensitive: false
  },
  {
    id: 'award.issuer', section: 'award',
    aliases: ['颁发单位', '颁奖单位', '颁发机构'],
    valueType: 'text', repeatable: true, sensitive: false
  },

  // ─── 证书（可重复，与在校获奖荣誉分开）──────────────────────
  {
    id: 'certificate.name', section: 'certificate',
    aliases: ['证书名称', '资格证书名称', '证书名'],
    valueType: 'text', repeatable: true, sensitive: false
  },
  {
    id: 'certificate.level', section: 'certificate',
    aliases: ['证书等级', '证书级别'],
    excludePatterns: [/英语|外语|语言|奖励|获奖/],
    valueType: 'text', repeatable: true, sensitive: false
  },
  {
    id: 'certificate.date', section: 'certificate',
    aliases: ['获得时间', '获证时间', '发证时间'],
    excludePatterns: [/获奖/],
    valueType: 'month', repeatable: true, sensitive: false
  },
  {
    id: 'certificate.issuer', section: 'certificate',
    aliases: ['发证机构', '发证单位', '发证机关'],
    valueType: 'text', repeatable: true, sensitive: false
  },
  {
    id: 'certificate.number', section: 'certificate',
    aliases: ['证书编号', '证书号'],
    excludePatterns: [/身份证|证件号码|证件号/],
    valueType: 'text', repeatable: true, sensitive: false
  },

  // ─── 技能 / 爱好 ───────────────────────────────────────────
  {
    id: 'skill.englishLevel', section: 'skill',
    aliases: ['英语水平', '英语等级', '外语水平', '外语等级'],
    enumValues: ['CET4', 'CET6', '专业四级', '专业八级', '雅思', '托福'],
    excludePatterns: [/成绩|得分|分数/],
    valueType: 'text', repeatable: false, sensitive: false
  },
  {
    id: 'skill.englishScore', section: 'skill',
    aliases: ['英语成绩得分', '英语成绩', '英语分数', '四六级分数'],
    valueType: 'number', repeatable: false, sensitive: false
  },
  {
    id: 'skill.hobbies', section: 'skill',
    aliases: ['个人爱好', '兴趣爱好', '爱好', '特长', '兴趣特长'],
    valueType: 'longtext', repeatable: false, sensitive: false
  },

  // ─── 家庭关系（可重复，默认敏感）───────────────────────────
  {
    id: 'family.name', section: 'family',
    aliases: ['姓名'],
    patterns: [/(家庭成员|成员|亲属).{0,4}姓名/],
    valueType: 'text', repeatable: true, sensitive: true
  },
  {
    id: 'family.relation', section: 'family',
    aliases: ['关系', '与本人关系', '称谓', '成员关系'],
    enumValues: ['父亲', '母亲', '配偶', '兄弟', '姐妹', '子女'],
    valueType: 'text', repeatable: true, sensitive: true
  },
  {
    id: 'family.employer', section: 'family',
    aliases: ['工作单位'],
    patterns: [/(家庭成员|成员|亲属|父|母).{0,4}(工作)?单位/],
    valueType: 'text', repeatable: true, sensitive: true
  },

  // ─── 自我评价 ───────────────────────────────────────────────
  {
    id: 'summary.content', section: 'summary',
    aliases: ['评价内容', '自我评价', '自我介绍', '个人总结', '个人评价', '个人优势', '职业目标'],
    patterns: [/self\s*(evaluation|introduction)|summary|profile/i],
    valueType: 'longtext', repeatable: false, sensitive: false
  }
]

const slotIndex = new Map(SLOTS.map(slot => [slot.id, slot]))

export function slotById(id: string): SlotDef | undefined {
  return slotIndex.get(id)
}

export function slotsBySection(section: SectionId): SlotDef[] {
  return SLOTS.filter(slot => slot.section === section)
}

export function allSlotIds(): string[] {
  return SLOTS.map(slot => slot.id)
}

export function sensitiveSlots(): SlotDef[] {
  return SLOTS.filter(slot => slot.sensitive)
}

/** 别名规范化命中：标签文本是否与某槽位的别名全等。 */
export function aliasHit(slot: SlotDef, text: string): boolean {
  const target = normalize(text)
  return Boolean(target) && slot.aliases.some(alias => normalize(alias) === target)
}

/** 旧叫法。只在调用方已经确定板块时使用。 */
export function legacyAliasHit(slot: SlotDef, text: string): boolean {
  const target = normalize(text)
  return Boolean(target) && Boolean(slot.legacyAliases?.some(alias => normalize(alias) === target))
}

/** 这个标签在几个板块里都是精确别名。大于 1 就不能学成全局别名。 */
export function aliasSectionCount(text: string): number {
  const sections = new Set<SectionId>()
  for (const slot of SLOTS) {
    if (aliasHit(slot, text)) sections.add(slot.section)
  }
  return sections.size
}

/** 在指定板块里按别名全等找槽位。跨板块同名时用来改回页面标题对应的槽位。 */
export function slotByAliasInSection(section: SectionId, text: string): SlotDef | undefined {
  return SLOTS.find(slot => slot.section === section && aliasHit(slot, text))
}

/**
 * 生成 AI 抽取 / 匹配用的字段 schema 文本（与旧 RESUME_FIELD_SCHEMA 契约一致，
 * group/key 使用中文规范名）。单一数据源：本表变更后 prompt 自动同步。
 */
export function promptFieldSchema(): string {
  const lines = SECTIONS.map(section => {
    const slots = slotsBySection(section.id)
    if (!slots.length) return ''
    const keys = slots.map(slot => slot.aliases[0]).join('、')
    return `- ${section.label}：${keys}`
  }).filter(Boolean)
  return `仅可使用以下板块与字段；同类多段经历使用 item=1、2、3 编号：\n${lines.join('\n')}`
}

/** 生成 AI 槽位匹配用的槽位清单（有限枚举，模型输出不在清单内即丢弃）。 */
export function promptSlotCatalog(): string {
  const lines = SECTIONS.map(section => {
    const slots = slotsBySection(section.id)
    if (!slots.length) return ''
    const entries = slots.map(slot => `${slot.id}（${slot.aliases[0]}）`).join('、')
    return `【${sectionLabel(section.id)}】${entries}`
  }).filter(Boolean)
  return lines.join('\n')
}
