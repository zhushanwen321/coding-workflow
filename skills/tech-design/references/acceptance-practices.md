# 验收最佳实践（业界参考）

> **本文件是准则 11（验收用真实场景验证）的业界依据与深度参考。** tech-design 的"真实场景验收"理念不是自创——它与业界 ATDD / BDD / SBE / 测试金字塔等主流实践高度一致。想深入理解"为什么这么要求验收"、或想借鉴具体写法时查本文件。
>
> 与 `design-principles.md` 准则 11 的关系：准则是规则（怎么做），本文件是依据（为什么 + 业界怎么做）。

## 一、验收 vs 单元测试：测试金字塔的权威分层

测试金字塔（Mike Cohn, *Succeeding with Agile*, 2009）给"代码逻辑"和"真实场景"划了清晰边界：

```
        验收 / E2E（顶层）      ← 用户视角，black-box，验证"用户能否达成业务目标"
       集成测试（中层）          ← 组件间真实协作，查 boundary bugs
      单元测试（底层，数量最多）  ← 单个函数逻辑，white-box，快
```

经典比例约 70% unit / 20% integration / 10% E2E。各层职责一句话区分：

> **Unit tests verify your code works. Acceptance tests verify your users can accomplish their goals.**
> （单元测试防止发布有 bug 的代码；验收测试防止发布"满足技术要求但不满足真实需求"的软件。）

后一种正是准则 11 要防的失败模式——单测全绿但功能在真实工作里不达标。

来源：[Testlio: Unit vs Acceptance](https://www.testlio.com/blog/unit-testing-vs-acceptance-testing) · [CircleCI: Testing Pyramid](https://circleci.com/blog/testing-pyramid) · [Autonoma: Integration vs E2E](https://getautonoma.com/blog/integration-vs-e2e-testing)

---

## 二、五个强相关实践（直接定义"真实场景验收"）

| 实践 | 核心理念 | 对准则 11 的贡献 |
|---|---|---|
| **ATDD** 验收测试驱动开发 | 写代码前，产品/开发/测试三方协作定义 pass/fail 验收，以验收驱动开发（outside-in），关注功能的结果/目的而非实现 | "用业务验收场景驱动"——验收是业务视角，不是技术视角 |
| **BDD** 行为驱动开发 | 用"行为/应该"而非"测试"，核心是 discovery（发现未知场景），而非预设已知行为 | Given-When-Then 的来源；"应该这样吗？有没有遗漏上下文？"驱动边界场景发现 |
| **SBE** 实例化需求 | 用真实业务例子规格化需求，需求说明=测试用例=活文档 | **从业务目标推导验收范围** + **用例子而非抽象规则**——准则 11 两个硬要求的直接来源 |
| **Given-When-Then** | Given(前置)→When(操作)→Then(预期)，用业务语言 | 验收场景的结构化写法；设计文档层借思路即可，不必上严格 Gherkin |
| **测试金字塔** | 三层测试各司其职，验收在顶 | 给"代码逻辑 vs 真实场景"权威分层（见上节） |

来源：[Wikipedia: ATDD](https://en.wikipedia.org/wiki/Acceptance_test-driven_development) · [Agile Alliance: BDD](https://agilealliance.org/glossary/bdd) · [Gojko Adzic: Specification by Example](https://www.goodreads.com/en/book/show/10288718-specification-by-example) · [AltexSoft: AC Best Practices](https://www.altexsoft.com/blog/acceptance-criteria-purposes-formats-and-best-practices) · [优普丰: ATDD 与实例化需求](https://www.uperform.cn/atdd-bdd-specification-by-example)

### SBE 的关键 process pattern（Gojko Adzic，7 个）

1. **Deriving scope from goals**（从业务目标推导范围）——准则 11「验收场景回溯 §1 目标」的来源
2. Specifying collaboratively（协作规格化）
3. **Illustrating using examples**（用例子说明）——准则 11「验收例子化」的来源
4. Refining the specification（精炼规格）
5. Automating validation（自动化验证——设计文档层不强求）
6. Validating frequently（频繁验证）
7. Evolving living documentation（演化活文档）

设计文档层主要吸收第 1、3 条（目标回溯 + 例子化），其余偏实施期。

---

## 三、两个补充实践（质量门槛与写法检查表）

### DoD / DoR（完成定义 / 就绪定义）

- **DoD**（Definition of Done）：团队共享的"完成"质量基线（代码审查、测试、文档、部署就绪）
- **DoR**（Definition of Ready）：PBI 可进入 sprint 的就绪标准——**包括"验收标准已定义且 testable"**
- **AC**（Acceptance Criteria）：单个 user story 特有的成功条件

关系：AC 回答"功能做对了吗（what）"；DoD 回答"可以发布了吗（quality）"。准则 11 借 DoR 的定位——**没有 testable 验收 = 设计未就绪**（对应审查 P0-13）。

来源：[Atlassian: DoD](https://www.atlassian.com/agile/project-management/definition-of-done) · [Scrum Alliance: DoR vs DoD](https://resources.scrumalliance.org/Article/definition-vs-ready) · [AltexSoft: AC vs DoD](https://www.altexsoft.com/blog/acceptance-criteria-definition-of-done)

### INVEST / SMART（写法质量检查表）

- **INVEST**（评估 user story）：好故事要 Independent / Negotiable / Valuable / Estimable / Small / **Testable**
- **SMART**（评估验收标准）：Specific / **Measurable** / Achievable / Relevant / Time-bound

核心可操作点：把模糊表述拆成可度量的——"系统应该快速响应" → "2 秒内返回结果"；"友好错误提示" → "错误提示含问题原因和建议操作"。这是准则 11「验收例子化、可测试」的写法工具。

来源：[Agile Alliance: INVEST](https://agilealliance.org/glossary/invest) · [Boost: INVEST](https://www.boost.co.nz/blog/2021/10/invest-criteria)

---

## 四、tech-design 吸收了哪些

| 业界实践 | 吸收进准则 11 的方式 |
|---|---|
| SBE「Deriving scope from goals」 | 怎么做硬要求：每个验收场景回溯 §1 业务目标 |
| SBE/ATDD「Illustrating using examples」 | 怎么做硬要求：验收用具体业务例子，不用抽象断言 |
| Given-When-Then | 验收场景的结构化写法（借思路，不上 Gherkin） |
| 测试金字塔 | 为什么段：给"代码 vs 真实场景"权威分层 |
| DoR | 定位：验收 testable = 设计就绪门槛 |
| SMART | 写法工具：模糊断言→可度量例子 |

**不吸收**：Gherkin 严格语法、Automating validation（自动化验证）——那是测试实施层，超出设计文档范畴。准则 11 管的是"设计阶段如何定义可执行的真实场景验收"，不是"如何把验收自动化成测试代码"。
