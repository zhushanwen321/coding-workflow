# Aider - Architect Mode 提示词调研

## 来源

- 仓库: Aider-AI/aider
- 本地路径: `~/GitApp/ai-agent/aider`
- commit hash: `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`
- 关键文件:
  - `aider/coders/architect_coder.py` — ArchitectCoder 类，双模型调度逻辑
  - `aider/coders/architect_prompts.py` — ArchitectPrompts，architect 阶段提示词
  - `aider/coders/ask_coder.py` / `ask_prompts.py` — ArchitectCoder 的父类
  - `aider/coders/base_prompts.py` — CoderPrompts 基类
  - `aider/coders/editblock_prompts.py` — editor 阶段实际使用的 EditBlock 系列提示词
  - `aider/coders/editblock_fenced_prompts.py` / `editor_diff_fenced_prompts.py` — editor 阶段提示词派生
  - `aider/coders/base_coder.py` — 提示词拼装逻辑 (`fmt_system_prompt` / `format_chat_chunks`)
  - `aider/models.py` — editor_model / editor_edit_format 解析逻辑
  - `aider/resources/model-settings.yml` — 各模型的默认 editor_model / editor_edit_format 配置
  - `aider/website/_posts/2024-09-26-architect.md` — 官方设计说明博客

## Architect Mode System Prompt

ArchitectCoder 的 `gpt_prompts` 是 `ArchitectPrompts` 实例。`ArchitectPrompts` 继承自 `CoderPrompts`（基类），**未重写 `main_system` 时会用基类的空串**——但这里它**重写了 `main_system`**。

实际生效的 main system prompt 来自 `aider/coders/architect_prompts.py`：

```python
main_system = """Act as an expert architect engineer and provide direction to your editor engineer.
Study the change request and the current code.
Describe how to modify the code to complete the request.
The editor engineer will rely solely on your instructions, so make them unambiguous and complete.
Explain all needed code changes clearly and completely, but concisely.
Just show the changes needed.

DO NOT show the entire updated function/file/etc!

Always reply to the user in {language}.
"""
```

### 提示词拼装机制（重要）

`main_system` 不会原样发送。`base_coder.py::format_chat_chunks()` 调用 `fmt_system_prompt(self.gpt_prompts.main_system)`，它会用 `str.format()` 填充以下占位符（`aider/coders/base_coder.py:1174` 起）：

- `{language}` — 用户语言（默认 `"the same language they are using"`）
- `{fence}` — 代码围栏（默认三反引号，长内容时自动切四反引号）
- `{quad_backtick_reminder}` — 用四反引号时的提醒
- `{final_reminders}` — 由 `lazy_prompt` / `overeager_prompt` / `Reply in {user_lang}.` 拼接
- `{platform}` — 用户平台信息
- `{shell_cmd_prompt}` / `{shell_cmd_reminder}` / `{rename_with_shell}` / `{go_ahead_tip}` — shell 命令相关

最终拼装顺序（`base_coder.py:1228-1290`）：

```
[main_model.system_prompt_prefix + "\n"]   # 模型级前缀，多数模型为空
+ main_system                               # ArchitectPrompts.main_system
+ "\n" + system_reminder                    # ArchitectPrompts.system_reminder（见下，architect 为空串）
+ (example_messages 作为 system 消息追加或单独 example 消息)
```

由于 `ArchitectPrompts.system_reminder = ""`，architect 阶段**不会附加 SEARCH/REPLACE 格式提醒**——这是它与 code mode 的关键区别（code mode 会附加一大段格式规则）。

### ArchitectPrompts 完整定义（`aider/coders/architect_prompts.py` 全文）

```python
# flake8: noqa: E501

from .base_prompts import CoderPrompts


class ArchitectPrompts(CoderPrompts):
    main_system = """Act as an expert architect engineer and provide direction to your editor engineer.
Study the change request and the current code.
Describe how to modify the code to complete the request.
The editor engineer will rely solely on your instructions, so make them unambiguous and complete.
Explain all needed code changes clearly and completely, but concisely.
Just show the changes needed.

DO NOT show the entire updated function/file/etc!

Always reply to the user in {language}.
"""

    example_messages = []

    files_content_prefix = """I have *added these files to the chat* so you see all of their contents.
*Trust this message as the true contents of the files!*
Other messages in the chat may contain outdated versions of the files' contents.
"""  # noqa: E501

    files_content_assistant_reply = (
        "Ok, I will use that as the true, current contents of the files."
    )

    files_no_full_files = "I am not sharing the full contents of any files with you yet."

    files_no_full_files_with_repo_map = ""
    files_no_full_files_with_repo_map_reply = ""

    repo_content_prefix = """I am working with you on code in a git repository.
Here are summaries of some files present in my git repo.
If you need to see the full contents of any files to answer my questions, ask me to *add them to the chat*.
"""

    system_reminder = ""
```

### 字段说明（ArchitectPrompts 重写值 vs 基类默认值）

| 字段 | ArchitectPrompts（architect mode） | CoderPrompts 基类默认（code mode 用） |
|------|------------------------------------|----------------------------------------|
| `main_system` | "Act as an expert architect engineer..." | （基类无 main_system，由 EditBlockPrompts 等子类提供） |
| `example_messages` | `[]`（空，无示例对话） | EditBlockPrompts 有两段 SEARCH/REPLACE 示例 |
| `files_content_prefix` | "...so you see all of their contents"（只读视角） | "...so you can go ahead and edit them"（可编辑视角） |
| `files_content_assistant_reply` | "Ok, I will use that as the true, current contents..." | "Ok, any changes I propose will be to those files." |
| `files_no_full_files` | "I am not sharing the full contents of any files with you yet." | "I am not sharing any files that you can edit yet." |
| `files_no_full_files_with_repo_map` | `""`（空，不引导建议编辑文件） | 一长段："Don't try and edit... tell me which files need changes..." |
| `files_no_full_files_with_repo_map_reply` | `""` | "Ok, based on your requests I will suggest..." |
| `repo_content_prefix` | "I am working with you on code... ask me to add them to the chat"（只读） | "Do not propose changes to these files, treat them as read-only..." |
| `system_reminder` | `""`（无格式规则） | EditBlockPrompts 有一大段 SEARCH/REPLACE 规则 |

注意：`main_system` 字段在基类 `CoderPrompts` 中**未定义**。ArchitectPrompts 直接在自身定义了 `main_system`，而它的兄弟 `AskPrompts`（architect 的父类）也定义了自己的 `main_system`。由于 Python MRO，`ArchitectPrompts` 自己的 `main_system` 覆盖了 `AskPrompts.main_system`。

## Architect Format Prompt（输出格式要求）

Architect mode 的设计哲学是：**architect 模型只负责描述方案，不负责产出可执行的 edit block**。因此它没有 SEARCH/REPLACE 格式约束，只有以下软性约束（全部嵌在 `main_system` 里）：

1. "Describe how to modify the code to complete the request." — 描述如何改
2. "Explain all needed code changes clearly and completely, but concisely." — 完整但简洁
3. "Just show the changes needed." — 只展示需要的改动
4. "DO NOT show the entire updated function/file/etc!" — 不要贴整文件/整函数

**没有独立的 format prompt 文件**。与 code mode 对比：code mode 会通过 `system_reminder` 注入一大段 `# *SEARCH/REPLACE block* Rules:`（见 `aider/coders/editblock_prompts.py`），强制模型按特定格式输出可解析的编辑块。architect mode 完全省略这部分，因为它的输出交给人类确认后，再丢给 editor 模型重新格式化。

`ArchitectPrompts.system_reminder = ""` 是这一设计的关键开关——它在 `format_chat_chunks()` 里两处被使用（`base_coder.py:1261` 拼到 system 消息尾部，`base_coder.py:1285/1318` 作为对话中段的 system reminder 消息），置空等于完全不注入格式提醒。

## 双模型机制（designer model + editor model）

### 核心流程

Architect mode 是**两阶段单轮对话**，定义在 `aider/coders/architect_coder.py::ArchitectCoder.reply_completed()`：

```
用户输入 change request
        │
        ▼
┌──────────────────────────────┐
│ 阶段 1: ArchitectCoder        │
│ - 用 main_model（designer）   │
│ - edit_format = "architect"  │
│ - gpt_prompts = ArchitectPrompts（无 SEARCH/REPLACE 约束）│
│ - 产出: 自然语言设计方案      │
└──────────────────────────────┘
        │
        ▼
   用户确认?（auto_accept_architect=False 时弹 "Edit the files?"）
        │ 是
        ▼
┌──────────────────────────────┐
│ 阶段 2: EditorCoder（新建）   │
│ - 用 editor_model            │
│ - edit_format = main_model.editor_edit_format（通常 "editor-diff"）│
│ - gpt_prompts = EditBlockFenced 系（带 SEARCH/REPLACE 约束）│
│ - 输入: 阶段1 的设计方案文本  │
│ - 产出: SEARCH/REPLACE 块 → 实际改文件 │
└──────────────────────────────┘
```

### 关键代码（`architect_coder.py` 全文逻辑解析）

```python
class ArchitectCoder(AskCoder):       # 注意：继承 AskCoder，不是直接继承 Coder
    edit_format = "architect"
    gpt_prompts = ArchitectPrompts()
    auto_accept_architect = False     # 默认需要用户确认才执行编辑

    def reply_completed(self):
        content = self.partial_response_content   # 阶段1 architect 模型的输出
        if not content or not content.strip():
            return
        # 用户确认环节
        if not self.auto_accept_architect and not self.io.confirm_ask("Edit the files?"):
            return

        kwargs = dict()
        # 选择 editor 模型：优先 main_model.editor_model，没有就用 main_model 自己
        editor_model = self.main_model.editor_model or self.main_model

        kwargs["main_model"] = editor_model
        kwargs["edit_format"] = self.main_model.editor_edit_format  # 如 "editor-diff"
        kwargs["suggest_shell_commands"] = False     # editor 阶段不建议 shell 命令
        kwargs["map_tokens"] = 0                     # editor 阶段不用 repo map
        kwargs["total_cost"] = self.total_cost       # 成本累计
        kwargs["cache_prompts"] = False
        kwargs["num_cache_warming_pings"] = 0
        kwargs["summarize_from_coder"] = False

        new_kwargs = dict(io=self.io, from_coder=self)  # from_coder 继承上下文
        new_kwargs.update(kwargs)

        editor_coder = Coder.create(**new_kwargs)
        # 清空对话历史，只把 architect 的方案作为新一轮输入
        editor_coder.cur_messages = []
        editor_coder.done_messages = []

        if self.verbose:
            editor_coder.show_announcements()

        # 关键：把阶段1 的设计方案 content 作为用户消息喂给 editor
        editor_coder.run(with_message=content, preproc=False)

        # 回填：告知 architect 上下文"已按方案改完"
        self.move_back_cur_messages("I made those changes to the files.")
        self.total_cost = editor_coder.total_cost
        self.aider_commit_hashes = editor_coder.aider_commit_hashes
```

### editor_model / editor_edit_format 的来源

定义在 `aider/models.py`：

1. **`Model` 类字段**（`models.py:145-146`）：
   ```python
   editor_model_name: Optional[str] = None
   editor_edit_format: Optional[str] = None
   ```

2. **解析逻辑 `get_editor_model()`**（`models.py:625-645`）：
   ```python
   def get_editor_model(self, provided_editor_model_name, editor_edit_format):
       if provided_editor_model_name:
           self.editor_model_name = provided_editor_model_name
       if editor_edit_format:
           self.editor_edit_format = editor_edit_format

       if not self.editor_model_name or self.editor_model_name == self.name:
           self.editor_model = self            # 没配 editor_model 就用自己
       else:
           self.editor_model = Model(
               self.editor_model_name,
               editor_model=False,
           )

       if not self.editor_edit_format:
           self.editor_edit_format = self.editor_model.edit_format
           # 把普通格式映射成 editor 专用格式
           if self.editor_edit_format in ("diff", "whole", "diff-fenced"):
               self.editor_edit_format = "editor-" + self.editor_edit_format

       return self.editor_model
   ```

3. **默认配置**（`aider/resources/model-settings.yml`）：每个强模型都预设了 `editor_model_name` 和 `editor_edit_format`。绝大多数配置为 `editor_edit_format: editor-diff`，搭配一个便宜/擅长的 editor 模型。典型例子：
   - `claude-3-5-sonnet` 系列 → editor 用 `claude-3-5-sonnet`，`editor-diff`
   - `claude-3-7-sonnet` 系列 → editor 用 `claude-3-7-sonnet`，`editor-diff`
   - Sonnet/Opus 4.x 等新模型 → `editor-diff`
   - DeepSeek 系列 → editor 用 `openrouter/deepseek/deepseek-chat`，`editor-diff`

### editor-diff 格式对应的 Coder / 提示词

`editor_edit_format = "editor-diff"` 路由到 `EditorDiffFencedCoder`（`aider/coders/editor_diff_fenced_coder.py`）：

```python
class EditorDiffFencedCoder(EditBlockFencedCoder):
    "A coder that uses search/replace blocks, focused purely on editing files."
    edit_format = "editor-diff-fenced"
    gpt_prompts = EditorDiffFencedPrompts()
```

提示词继承链：`EditorDiffFencedPrompts` → `EditBlockFencedPrompts` → `EditBlockPrompts` → `CoderPrompts`。

`EditorDiffFencedPrompts` 的特殊之处（`editor_diff_fenced_prompts.py`）：**把所有 shell 相关字段清空**，因为 editor 阶段 `suggest_shell_commands=False`：

```python
class EditorDiffFencedPrompts(EditBlockFencedPrompts):
    shell_cmd_prompt = ""
    no_shell_cmd_prompt = ""
    shell_cmd_reminder = ""
    go_ahead_tip = ""
    rename_with_shell = ""
```

其余（`main_system`、`example_messages`、`system_reminder`）全部继承自 `EditBlockFencedPrompts` / `EditBlockPrompts`——也就是说，**editor 阶段用的是标准 code mode 的 SEARCH/REPLACE 提示词**。

### editor 阶段实际生效的 main_system（来自 `editblock_prompts.py`）

```python
main_system = """Act as an expert software developer.
Always use best practices when coding.
Respect and use existing conventions, libraries, etc that are already present in the code base.
{final_reminders}
Take requests for changes to the supplied code.
If the request is ambiguous, ask questions.

Once you understand the request you MUST:

1. Decide if you need to propose *SEARCH/REPLACE* edits to any files that haven't been added to the chat. You can create new files without asking!

But if you need to propose edits to existing files not already added to the chat, you *MUST* tell the user their full path names and ask them to *add the files to the chat*.
End your reply and wait for their approval.
You can keep asking if you then decide you need to edit more files.

2. Think step-by-step and explain the needed changes in a few short sentences.

3. Describe each change with a *SEARCH/REPLACE block* per the examples below.

All changes to files must use this *SEARCH/REPLACE block* format.
ONLY EVER RETURN CODE IN A *SEARCH/REPLACE BLOCK*!
{shell_cmd_prompt}
"""
```

editor 阶段的 `system_reminder`（SEARCH/REPLACE 格式规则，来自 `editblock_fenced_prompts.py`，在 `format_chat_chunks` 中拼到 system 消息末尾及对话中段）：

```python
system_reminder = """
# *SEARCH/REPLACE block* Rules:

Every *SEARCH/REPLACE block* must use this format:
1. The opening fence and code language, eg: {fence[0]}python
2. The *FULL* file path alone on a line, verbatim. No bold asterisks, no quotes around it, no escaping of characters, etc.
3. The start of search block: <<<<<<< SEARCH
4. A contiguous chunk of lines to search for in the existing source code
5. The dividing line: =======
6. The lines to replace into the source code
7. The end of the replace block: >>>>>>> REPLACE
8. The closing fence: {fence[1]}

Use the *FULL* file path, as shown to you by the user.
{quad_backtick_reminder}
Every *SEARCH* section must *EXACTLY MATCH* the existing file content, character for character, including all comments, docstrings, etc.
If the file contains code or other data wrapped/escaped in json/xml/quotes or other containers, you need to propose edits to the literal contents of the file, including the container markup.

*SEARCH/REPLACE* blocks will *only* replace the first match occurrence.
Including multiple unique *SEARCH/REPLACE* blocks if needed.
Include enough lines in each SEARCH section to uniquely match each set of lines that need to change.

Keep *SEARCH/REPLACE* blocks concise.
Break large *SEARCH/REPLACE* blocks into a series of smaller blocks that each change a small portion of the file.
Include just the changing lines, and a few surrounding lines if needed for uniqueness.
Do not include long runs of unchanging lines in *SEARCH/REPLACE* blocks.

Only create *SEARCH/REPLACE* blocks for files that the user has added to the chat!

To move code within a file, use 2 *SEARCH/REPLACE* blocks: 1 to delete it from its current location, 1 to insert it in the new location.

Pay attention to which filenames the user wants you to edit, especially if they are asking you to create a new file.

If you want to put code in a new file, use a *SEARCH/REPLACE block* with:
- A new file path, including dir name if needed
- An empty `SEARCH` section
- The new file's contents in the `REPLACE` section

To rename files which are added to the chat, use shell commands at the end of your response.

If the user just says something like "ok" or "go ahead" or "do that" they probably want you to make SEARCH/REPLACE blocks for the code changes you just proposed.
The user will say when they've applied your edits. If they haven't explicitly confirmed the edits have been applied, they probably want proper SEARCH/REPLACE blocks.

{final_reminders}
ONLY EVER RETURN CODE IN A *SEARCH/REPLACE BLOCK*!
{shell_cmd_reminder}
"""
```

editor 阶段还会带上 `example_messages`（两段 SEARCH/REPLACE 示例对话，见 `editblock_fenced_prompts.py`），architect 阶段则没有示例。

### 官方设计意图（博客 `2024-09-26-architect.md`）

> An Architect model is asked to describe how to solve the coding problem.
> An Editor model is given the Architect's solution and asked to produce specific code editing instructions to apply those changes to existing source files.
>
> Splitting up "code reasoning" and "code editing" in this manner has produced SOTA results...

核心论点：**把"代码推理"和"代码编辑"分离**。强推理模型（如 o1-preview）擅长设计方案但不擅长精确输出 diff 格式；便宜/擅长格式的模型（如 DeepSeek、o1-mini）负责把方案翻译成 SEARCH/REPLACE 块。组合后 benchmark 分数超过任一模型单独工作。

## 与 code/ask mode 提示词的差异

### 三种 mode 的 main_system 对比

| mode | Coder 类 | Prompts 类 | main_system 核心指令 | edit_format |
|------|----------|------------|---------------------|-------------|
| **code**（默认 diff） | `EditBlockCoder` | `EditBlockPrompts` | "Act as an expert software developer... Take requests for changes... Describe each change with a *SEARCH/REPLACE block*" | `diff` |
| **ask** | `AskCoder` | `AskPrompts` | "Act as an expert code analyst. Answer questions... If you need to describe code changes, do so *briefly*." | `ask` |
| **architect** | `ArchitectCoder(AskCoder)` | `ArchitectPrompts` | "Act as an expert architect engineer and provide direction to your editor engineer... DO NOT show the entire updated function/file/etc!" | `architect` |

### architect vs code 的关键差异

1. **角色定位**：
   - code: "expert software developer"（直接干活的程序员）
   - architect: "expert architect engineer"（架构师，向 editor 工程师下达指令）

2. **输出约束**：
   - code: 必须输出 SEARCH/REPLACE 块（通过 `system_reminder` 强制）
   - architect: 只描述改动，**禁止贴整文件**（`DO NOT show the entire updated function/file/etc!`），不要求特定格式

3. **格式提醒 `system_reminder`**：
   - code: 一大段 SEARCH/REPLACE 规则（`EditBlockPrompts.system_reminder`）
   - architect: 空串（完全不约束输出格式）

4. **示例对话 `example_messages`**：
   - code: 两段完整的 SEARCH/REPLACE 示例
   - architect: 空列表

5. **文件视角 `files_content_prefix`**：
   - code: "so you can go ahead and **edit** them"（可编辑）
   - architect: "so you **see** all of their contents"（只读，architect 不直接改）

6. **repo map 引导 `files_no_full_files_with_repo_map`**：
   - code: 引导模型建议哪些文件需要编辑
   - architect: 空串（architect 不主动建议编辑文件清单，只分析给定文件）

7. **是否真正改文件**：
   - code: 模型输出直接被解析、应用
   - architect: 模型输出先给人类确认，再喂给第二个 editor 模型重新格式化后才应用

### architect vs ask 的关键差异

architect 继承自 ask，两者都不直接改文件，但定位不同：

| 维度 | ask | architect |
|------|-----|-----------|
| 角色 | code analyst（分析师） | architect engineer（架构师） |
| 目的 | 回答问题 | 为 editor 工程师提供明确完整的改动指令 |
| 改动描述 | "do so *briefly*"（简短） | "clearly and completely, but concisely"（完整简洁） |
| overeager_prompt | "Do not return fully detailed code or full diffs. Describe the needed changes or give a plan." | （继承基类默认）"Do what they ask, but no more..." |
| 后续动作 | 无（纯问答结束） | 触发 editor 模型执行编辑 |
| system_reminder | `"{final_reminders}"`（有内容） | `""`（空） |

ask mode 的 `overeager_prompt` 主动抑制详细代码输出；architect mode 反而要求"完整"（因为 editor 要靠它干活）。这是继承链上的有意覆盖。

## 备注

1. **`ArchitectCoder` 继承 `AskCoder` 而非 `Coder`**：这是一个容易看漏的点。`AskCoder` 本身只是 `Coder` 的薄封装（只设 `edit_format="ask"` + `gpt_prompts=AskPrompts()`），但 `ArchitectCoder` 通过覆盖 `gpt_prompts=ArchitectPrompts()` 切换了提示词，并通过覆盖 `reply_completed()` 注入了双模型调度逻辑。继承 AskCoder 主要是为了复用"不改文件"的语义基线。

2. **`auto_accept_architect` 开关**：默认 `False`，architect 产出方案后会弹 "Edit the files?" 让用户确认。设为 `True`（CLI `--auto-accept-architect`）则跳过确认直接进入 editor 阶段。这是 architect mode 作为"plan mode"的人工检查点。

3. **editor 阶段的上下文隔离**：`editor_coder.cur_messages = []; editor_coder.done_messages = []` 清空了对话历史，只通过 `from_coder=self` 继承文件内容和 repo 状态，再用 `run(with_message=content)` 把 architect 的方案作为唯一输入。这避免了 architect 阶段的推理过程污染 editor，editor 只看到"最终方案文本"。

4. **成本与 commit 归属**：`self.total_cost = editor_coder.total_cost` 累加两阶段成本；`self.aider_commit_hashes = editor_coder.aider_commit_hashes` 把 editor 阶段产生的 git commit 归到 architect coder 名下。

5. **`map_tokens=0`**：editor 阶段禁用 repo map（`EditorDiffFencedCoder` 只处理已加入 chat 的文件）。architect 阶段正常用 repo map（`repo_content_prefix` 非空）。

6. **没有独立的 `.md` 提示词文件**：aider 的提示词全部以 Python 字符串形式内嵌在 `aider/coders/*_prompts.py` 中（历史上曾有 `.md` 文件，现已废弃）。所有占位符（`{language}` / `{fence}` / `{final_reminders}` 等）在 `base_coder.py::fmt_system_prompt()` 中统一 `str.format()` 填充。

7. **editor_edit_format 的多样性**：虽然绝大多数模型配 `editor-diff`，但代码里支持 `editor-whole`、`editor-editblock` 等变体（见 `editor_whole_coder.py` / `editor_editblock_coder.py`）。`get_editor_model()` 会把基础格式 `diff`/`whole`/`diff-fenced` 自动加 `editor-` 前缀。

8. **`main_model.editor_model or self.main_model` 的兜底**：如果模型未配置 editor_model（`editor_model_name` 为 None），`editor_model` 就是 `self`，此时 architect 和 editor 用同一个模型——退化为"单模型自言自语"，但仍走两阶段流程（先方案后格式化），对擅长推理但弱格式的模型仍有增益。
