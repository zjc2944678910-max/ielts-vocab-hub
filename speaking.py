#!/usr/bin/env python3
"""IELTS speaking prompts and conservative local feedback."""

from __future__ import annotations

import random
import re
from typing import Any


PARTS = ("part1", "part2", "part3")
PART_ALIASES = {
    "1": "part1", "part 1": "part1", "part1": "part1",
    "2": "part2", "part 2": "part2", "part2": "part2",
    "3": "part3", "part 3": "part3", "part3": "part3",
}
PART_META = {
    "part1": {
        "label": "Part 1",
        "title": "熟悉话题问答",
        "summary": "3 道日常问题，每题约 45 秒。像和考官闲聊，但答案要完整。",
        "prep_seconds": 0,
        "answer_seconds": 45,
        "questions_per_set": 3,
        "target_words": (40, 90),
    },
    "part2": {
        "label": "Part 2",
        "title": "个人陈述",
        "summary": "1 分钟准备、2 分钟连续说。覆盖提示卡上的要点，并给出原因。",
        "prep_seconds": 60,
        "answer_seconds": 120,
        "questions_per_set": 1,
        "target_words": (150, 260),
    },
    "part3": {
        "label": "Part 3",
        "title": "抽象讨论",
        "summary": "2 至 3 道延伸问题，每题约 60 秒。先给立场，再解释，最后收束。",
        "prep_seconds": 0,
        "answer_seconds": 60,
        "questions_per_set": 3,
        "target_words": (70, 140),
    },
}

PART1_TOPICS: list[dict[str, Any]] = [
    {
        "id": "hometown",
        "topic": "Hometown",
        "prompts": [
            "Where is your hometown, and what is it known for?",
            "What do you like most about living there?",
            "Has your hometown changed much in recent years?",
        ],
    },
    {
        "id": "work-study",
        "topic": "Work and study",
        "prompts": [
            "Do you work or are you a student, and what do you do each day?",
            "What is the most interesting part of your work or studies?",
            "What would you like to do after you finish this stage of your life?",
        ],
    },
    {
        "id": "daily-routine",
        "topic": "Daily routine",
        "prompts": [
            "What does a typical weekday look like for you?",
            "Which part of the day do you enjoy most, and why?",
            "How do you usually relax after a busy day?",
        ],
    },
    {
        "id": "food",
        "topic": "Food",
        "prompts": [
            "What kinds of food do you usually eat at home?",
            "Do you prefer cooking or eating out?",
            "Have your eating habits changed as you have grown older?",
        ],
    },
    {
        "id": "friends",
        "topic": "Friends",
        "prompts": [
            "How did you meet your closest friend?",
            "What do you usually do when you spend time with friends?",
            "Do you think it is easy to make new friends as an adult?",
        ],
    },
    {
        "id": "technology",
        "topic": "Technology",
        "prompts": [
            "What electronic device do you use most often?",
            "How has technology changed the way you study or work?",
            "Do you think people spend too much time on their phones?",
        ],
    },
    {
        "id": "weather",
        "topic": "Weather and seasons",
        "prompts": [
            "What kind of weather do you enjoy most?",
            "How does the weather affect your daily plans?",
            "Which season is your favourite, and why?",
        ],
    },
    {
        "id": "reading",
        "topic": "Reading",
        "prompts": [
            "Do you prefer reading on paper or on a screen?",
            "What was the last thing you read that you found useful?",
            "How can reading help people who are learning English?",
        ],
    },
]

PART2_TOPICS: list[dict[str, Any]] = [
    {
        "id": "new-skill",
        "topic": "Learning",
        "title": "Describe a skill you would like to learn",
        "bullets": [
            "what the skill is",
            "how you would learn it",
            "how long it might take",
            "and explain why this skill would be useful to you",
        ],
        "follow_ups": [
            "Should schools spend more time teaching practical skills?",
            "Why do some adults find it harder to learn new things?",
            "How might technology change the way people learn in the future?",
        ],
    },
    {
        "id": "water-place",
        "topic": "Places",
        "title": "Describe a place near water that you enjoyed visiting",
        "bullets": [
            "where the place is",
            "what you did there",
            "who you were with",
            "and explain why you enjoyed it",
        ],
        "follow_ups": [
            "Why do many cities develop around rivers or coasts?",
            "What problems can tourism cause for natural water areas?",
            "Should governments protect beaches and lakes even if it costs money?",
        ],
    },
    {
        "id": "advertisement",
        "topic": "Media",
        "title": "Describe an advertisement that you remember well",
        "bullets": [
            "where you saw it",
            "what it was advertising",
            "what it looked or sounded like",
            "and explain why it stayed in your memory",
        ],
        "follow_ups": [
            "Do advertisements influence young people too much?",
            "Are celebrity endorsements more persuasive than ordinary customer reviews?",
            "How can the public tell the difference between useful information and marketing?",
        ],
    },
    {
        "id": "teacher-figure",
        "topic": "People",
        "title": "Describe a person who taught you something important",
        "bullets": [
            "who the person is",
            "what they taught you",
            "how they taught you",
            "and explain why the lesson still matters",
        ],
        "follow_ups": [
            "What qualities make someone a good teacher?",
            "Is learning from people more effective than learning from videos?",
            "How should societies recognise the work of teachers?",
        ],
    },
    {
        "id": "helping",
        "topic": "Society",
        "title": "Describe a time when you helped someone",
        "bullets": [
            "who you helped",
            "what the situation was",
            "what you did",
            "and explain how you felt afterwards",
        ],
        "follow_ups": [
            "Should helping others be taught at school or at home?",
            "Do people in cities help strangers less than people in small towns?",
            "What is the difference between charity and everyday kindness?",
        ],
    },
    {
        "id": "building",
        "topic": "Urban life",
        "title": "Describe an interesting building you have seen",
        "bullets": [
            "where the building is",
            "what it looks like",
            "what it is used for",
            "and explain why you find it interesting",
        ],
        "follow_ups": [
            "Should cities preserve old buildings even when land is expensive?",
            "How does architecture affect the way people feel in public spaces?",
            "What makes a building environmentally responsible?",
        ],
    },
]

UPGRADES = [
    {"from": "I think", "to": "I would argue that", "why": "更像考场立场，而不是闲聊口吻。"},
    {"from": "a lot of", "to": "a considerable number of", "why": "替换空泛的数量词。"},
    {"from": "very good", "to": "particularly worthwhile", "why": "用更具体的评价代替 very + 形容词。"},
    {"from": "people", "to": "residents / the public", "why": "按语境收窄主语，避免空泛。"},
    {"from": "more and more", "to": "an increasing number of", "why": "更接近 Part 3 的书面口语。"},
    {"from": "because", "to": "mainly because / due to the fact that", "why": "让因果连接不那么小学生。"},
    {"from": "good for", "to": "beneficial to", "why": "学术一点，但仍适合口语。"},
    {"from": "bad", "to": "problematic / harmful", "why": "把笼统的贬义说清楚。"},
    {"from": "nowadays", "to": "in recent years", "why": "避免套话开头。"},
    {"from": "something like", "to": "such as", "why": "举例更干净。"},
]

CRITERION_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["band", "comment"],
    "properties": {
        "band": {"type": "number"},
        "comment": {"type": "string", "minLength": 1, "maxLength": 400},
    },
}
FEEDBACK_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["band_overall", "fluency", "vocabulary", "grammar", "task", "upgrades", "model_answer"],
    "properties": {
        "band_overall": {"type": "number"},
        "fluency": CRITERION_SCHEMA,
        "vocabulary": CRITERION_SCHEMA,
        "grammar": CRITERION_SCHEMA,
        "task": CRITERION_SCHEMA,
        "upgrades": {
            "type": "array",
            "minItems": 4,
            "maxItems": 8,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["from", "to", "why"],
                "properties": {
                    "from": {"type": "string", "minLength": 1, "maxLength": 80},
                    "to": {"type": "string", "minLength": 1, "maxLength": 120},
                    "why": {"type": "string", "minLength": 1, "maxLength": 160},
                },
            },
        },
        "model_answer": {"type": "string", "minLength": 1, "maxLength": 1800},
    },
}


def normalize_part(value: Any) -> str:
    key = re.sub(r"\s+", " ", str(value or "").strip().casefold())
    part = PART_ALIASES.get(key)
    if not part:
        raise ValueError("请选择 Part 1、Part 2 或 Part 3")
    return part


def word_count(text: str) -> int:
    return len(re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?|[\u3400-\u9fff]", text or ""))


def clamp_band(value: Any, low: float = 4.0, high: float = 9.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = 5.0
    snapped = round(number * 2) / 2
    return max(low, min(high, snapped))


def _item(item_id: str, prompt: str, bullets: list[str] | None = None) -> dict[str, Any]:
    return {"id": item_id, "prompt": prompt, "bullets": list(bullets or [])}


def build_set(part: Any, *, rng: random.Random | None = None) -> dict[str, Any]:
    chosen = normalize_part(part)
    meta = PART_META[chosen]
    picker = rng or random.Random()
    if chosen == "part1":
        topic = picker.choice(PART1_TOPICS)
        items = [_item(f"{topic['id']}-{index}", prompt) for index, prompt in enumerate(topic["prompts"])]
        context = ""
    else:
        topic = picker.choice(PART2_TOPICS)
        if chosen == "part2":
            items = [_item(topic["id"], topic["title"], topic["bullets"])]
            context = ""
        else:
            items = [_item(f"{topic['id']}-p3-{index}", prompt) for index, prompt in enumerate(topic["follow_ups"])]
            context = topic["title"]
    return {
        "part": chosen,
        "label": meta["label"],
        "title": meta["title"],
        "summary": meta["summary"],
        "topic": topic["topic"],
        "context": context,
        "prep_seconds": meta["prep_seconds"],
        "answer_seconds": meta["answer_seconds"],
        "target_words": {"min": meta["target_words"][0], "max": meta["target_words"][1]},
        "items": items,
    }


def normalize_attempt(payload: dict[str, Any] | None) -> dict[str, Any]:
    data = payload if isinstance(payload, dict) else {}
    part = normalize_part(data.get("part") or "part1")
    prompt = str(data.get("prompt") or "").strip()
    if len(prompt) < 8:
        raise ValueError("缺少有效的口语题目")
    answer = str(data.get("answer") or "").strip()
    if len(answer) > 8000:
        raise ValueError("作答过长，请把回答压缩到两分钟以内")
    bullets = [str(item).strip() for item in (data.get("bullets") or []) if str(item).strip()][:6]
    topic = str(data.get("topic") or "").strip()[:80]
    return {
        "part": part,
        "topic": topic,
        "prompt": prompt[:500],
        "bullets": bullets,
        "answer": answer,
        "word_count": word_count(answer),
    }


def _length_band(count: int, minimum: int, maximum: int) -> float:
    if count < 8:
        return 4.0
    if count < minimum * 0.45:
        return 5.0
    if count < minimum:
        return 5.5
    if count <= maximum:
        return 6.0
    return 6.0


def _cover_bullets(answer: str, bullets: list[str]) -> int:
    text = answer.casefold()
    covered = 0
    for bullet in bullets:
        tokens = [token for token in re.findall(r"[a-z]{4,}", bullet.casefold()) if token not in {"that", "with", "this", "would", "explain"}]
        if tokens and any(token in text for token in tokens[:3]):
            covered += 1
    return covered


def _pick_upgrades(answer: str) -> list[dict[str, str]]:
    text = answer.casefold()
    matched = [item for item in UPGRADES if item["from"].casefold() in text]
    chosen = matched[:6]
    for item in UPGRADES:
        if len(chosen) >= 6:
            break
        if item not in chosen:
            chosen.append(item)
    return chosen[:6]


def heuristic_feedback(attempt: dict[str, Any]) -> dict[str, Any]:
    meta = PART_META[attempt["part"]]
    count = attempt["word_count"]
    minimum, maximum = meta["target_words"]
    length_band = _length_band(count, minimum, maximum)
    covered = _cover_bullets(attempt["answer"], attempt["bullets"])
    task_band = length_band
    if attempt["bullets"]:
        if covered == 0 and count >= 8:
            task_band = min(task_band, 5.0)
        elif covered < len(attempt["bullets"]) / 2:
            task_band = min(task_band, 5.5)
    vocab_band = 6.0 if any(word in attempt["answer"].casefold() for word in ("because", "however", "although", "for example")) else 5.5
    if count < 8:
        vocab_band = 4.5
    grammar_band = 5.5 if count >= 20 else 5.0
    fluency_band = length_band
    overall = clamp_band((fluency_band + vocab_band + grammar_band + task_band) / 4, high=6.0)
    notice = "这是未调用模型时的保守点评：只看长度、覆盖度和几个常见替换。配置 API 后可获得考官式分数和示范回答。"
    if count < 8:
        comments = {
            "fluency": "几乎没有连续内容，还不能按口语分数去估。",
            "vocabulary": "有效词汇过少，先把想法说完整。",
            "grammar": "句子还没展开，无法判断结构。",
            "task": "没有回答到题目要求。",
        }
        model_answer = (
            "I would start by answering the question directly, then add one reason and a short example. "
            "For instance, I would mention a specific place or person, explain how it affected me, "
            "and finish with a clear personal view."
        )
    else:
        comments = {
            "fluency": f"大约 {count} 词。Part 目标大概 {minimum}–{maximum} 词；偏短会像没说完，偏长也未必加分。" if count < minimum else f"长度大约 {count} 词，已经够支撑一轮回答。下一步是减少重复、把停顿用在思考而不是卡词。",
            "vocabulary": "能看懂意思，但还偏日常。把 I think / a lot of / good 换成更准的词，分数才上得去。",
            "grammar": "先保证主谓完整。可以试 because / although / which 把两句合成一句。",
            "task": "有在回答问题。" + (f"提示卡 {covered}/{len(attempt['bullets'])} 点有被点到。" if attempt["bullets"] else "补充一个原因和一个具体例子会更稳。"),
        }
        model_answer = (
            f"To answer this, I would first address the topic of {attempt['topic'] or 'the question'} directly. "
            "I would give one clear example from daily life, explain why it matters, "
            "and then finish with a short personal view so the answer does not fade out."
        )
    return {
        "band_overall": overall,
        "fluency": {"band": fluency_band, "comment": comments["fluency"]},
        "vocabulary": {"band": vocab_band, "comment": comments["vocabulary"]},
        "grammar": {"band": grammar_band, "comment": comments["grammar"]},
        "task": {"band": task_band, "comment": comments["task"]},
        "upgrades": _pick_upgrades(attempt["answer"]),
        "model_answer": model_answer,
        "word_count": count,
        "notice": notice,
    }


def normalize_feedback(result: dict[str, Any] | None, *, attempt: dict[str, Any] | None = None) -> dict[str, Any]:
    data = result if isinstance(result, dict) else {}
    fallback = heuristic_feedback(attempt or {"part": "part1", "topic": "", "prompt": "practice", "bullets": [], "answer": "", "word_count": 0})

    def criterion(name: str) -> dict[str, Any]:
        raw = data.get(name) if isinstance(data.get(name), dict) else {}
        comment = str(raw.get("comment") or fallback[name]["comment"]).strip()[:400]
        return {"band": clamp_band(raw.get("band"), high=9.0), "comment": comment or fallback[name]["comment"]}

    upgrades: list[dict[str, str]] = []
    for item in data.get("upgrades") or []:
        if not isinstance(item, dict):
            continue
        source = str(item.get("from") or "").strip()[:80]
        target = str(item.get("to") or "").strip()[:120]
        why = str(item.get("why") or "").strip()[:160]
        if source and target and why:
            upgrades.append({"from": source, "to": target, "why": why})
        if len(upgrades) >= 8:
            break
    if len(upgrades) < 4:
        upgrades = (upgrades + fallback["upgrades"])[:6]
    overall = clamp_band(data.get("band_overall"), high=9.0)
    feedback = {
        "band_overall": overall,
        "fluency": criterion("fluency"),
        "vocabulary": criterion("vocabulary"),
        "grammar": criterion("grammar"),
        "task": criterion("task"),
        "upgrades": upgrades[:8],
        "model_answer": str(data.get("model_answer") or fallback["model_answer"]).strip()[:1800],
        "word_count": (attempt or {}).get("word_count", fallback["word_count"]),
        "notice": "",
    }
    if not feedback["model_answer"]:
        feedback["model_answer"] = fallback["model_answer"]
    return feedback


def feedback_messages(attempt: dict[str, Any]) -> list[dict[str, str]]:
    bullets = "\n".join(f"- {item}" for item in attempt["bullets"]) or "(no cue-card bullets)"
    user = (
        f"Part: {attempt['part']}\n"
        f"Topic: {attempt['topic'] or 'n/a'}\n"
        f"Prompt: {attempt['prompt']}\n"
        f"Cue bullets:\n{bullets}\n\n"
        f"Candidate answer ({attempt['word_count']} words):\n{attempt['answer'] or '[empty]'}\n"
    )
    system = (
        "You are a strict IELTS Speaking examiner for Chinese learners. "
        "Return JSON only, matching the schema. "
        "Write criterion comments in Chinese. "
        "Write upgrades.from, upgrades.to, and model_answer in English. "
        "Be conservative: 7.0 requires clear development and precise vocabulary; do not inflate. "
        "Give 4 to 8 upgrades that actually improve this answer. "
        "model_answer should be 90-160 words, spoken English, not an essay."
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]
