"""Read only dated release rows from official HTML calendars."""

import re
from calendar import month_name
from datetime import date, time
from unicodedata import normalize

from lxml import html

from .events import event, family


def text(node):
    return " ".join(" ".join(node.itertext()).split())


def month(value):
    return next(
        i for i, name in enumerate(month_name) if i and value[:3].lower() == name[:3].lower()
    )


def clock(value):
    m = re.fullmatch(r"(\d{1,2}):(\d{2})\s*([ap]m)?", value.lower().replace(".", "").strip())
    if not m:
        return None
    hour = int(m[1])
    if m[3]:
        hour = hour % 12 + (12 if m[3] == "pm" else 0)
    return time(hour, int(m[2]))


def cells(row):
    return [text(c) for c in row.xpath("./td")]


def census(s, root):
    for row in root.xpath("//tr[td[@sorttable_customkey]]"):
        c = cells(row)
        key = row.xpath("td[@sorttable_customkey]/@sorttable_customkey")[0]
        if len(c) < 4 or not re.fullmatch(r"\d{12}", key) or not (zh := family(c[0])):
            continue
        yield event(
            s,
            f"{c[0]} ({c[3]})",
            zh,
            date.fromisoformat(key[:8]),
            clock=clock(c[2]),
            identity=(c[0], c[3]),
        )


def fred(s, root):
    rid = s.key.split("-")[-1]
    for link in root.xpath(f"//tr/td/a[@href='/release?rid={rid}']"):
        row = link.getparent().getparent()
        heading = row.xpath("preceding-sibling::tr[td[@colspan]][1]")
        if not heading:
            continue
        m = re.search(r"([A-Za-z]+) (\d{1,2}), (\d{4})", text(heading[0]))
        if m:
            yield event(
                s,
                text(link),
                family(text(link)) or "劳动力市场统计",
                date(int(m[3]), month(m[1]), int(m[2])),
                clock=clock(cells(row)[0]),
            )


def fomc(s, root):
    for node in root.xpath("//div[contains(@class,'fomc-meeting__month')]"):
        heading = node.xpath("preceding::h4[1]")
        match = re.match(r"(\d{4}) FOMC Meetings", text(heading[0])) if heading else None
        day = node.xpath("following-sibling::div[contains(@class,'fomc-meeting__date')][1]")
        if not match or not day:
            continue
        m = re.fullmatch(r"(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\*?", text(day[0]))
        if not m:
            continue
        months = re.split(r"[/–-]", text(node))
        year = int(match[1])
        start = date(year, month(months[0]), int(m[1]))
        end = date(year, month(months[-1]), int(m[2] or m[1]))
        yield event(
            s, "FOMC meeting", "联邦公开市场委员会会议", start, end=end, status="provisional"
        )


def fedmonth(s, root):
    y, mo = s.key.split("-")[1:]
    for node in root.xpath("//div[@class='col-xs-7']"):
        label = node.xpath("./p[1]")
        kind = text(label[0]) if label else ""
        titles = {
            "FOMC Meeting": ("FOMC policy announcement", "美联储政策决定"),
            "FOMC Press Conference": ("FOMC press conference", "美联储新闻发布会"),
        }
        if kind not in titles:
            continue
        day = node.xpath("following-sibling::div[@class='col-xs-3']")
        when = node.xpath("preceding-sibling::div[@class='col-xs-2']")
        if day and text(day[0]).isdigit() and when:
            yield event(
                s,
                *titles[kind],
                date(int(y), month(mo), int(text(day[0]))),
                clock=clock(text(when[0])),
            )


def boe(s, root):
    for table in root.xpath("//table"):
        heading = table.xpath("preceding::h2[1]")
        year = (
            re.search(r"(\d{4}) (confirmed|provisional) dates", text(heading[0]), re.I)
            if heading
            else None
        )
        if not year:
            continue
        for row in table.xpath(".//tr[td]"):
            c = cells(row)
            m = re.search(r"(\d{1,2}) ([A-Za-z]+)", c[0])
            if m:
                explicit = re.search(r"(\d{1,2}[:.]\d{2}\s*(?:am|pm)?)", " ".join(c), re.I)
                release = clock(explicit[1].replace(".", ":")) if explicit else time(12)
                yield event(
                    s,
                    "MPC policy decision and minutes",
                    "英国央行政策决定及会议纪要",
                    date(int(year[1]), month(m[2]), int(m[1])),
                    clock=release,
                    time_source_url=s.url
                    if explicit
                    else "https://www.bankofengland.co.uk/monetary-policy",
                    status="finalised" if year[2].lower() == "confirmed" else "provisional",
                )


def ecb(s, root):
    first_day = None
    for dt in root.xpath("//dl/dt"):
        dd = dt.xpath("following-sibling::*[1][self::dd]")
        stamp = re.match(r"(\d{2})/(\d{2})/(\d{4})(?:\s+(\d{2}:\d{2}))?", text(dt))
        if not dd or not stamp:
            continue
        day = date(int(stamp[3]), int(stamp[2]), int(stamp[1]))
        details = text(dd[0])
        if s.key == "ecb":
            if re.search(r": monetary policy meeting.*\(Day 1\)", details, re.I):
                first_day = day
            if re.search(r": monetary policy meeting.*\(Day 2\)", details, re.I):
                if first_day and (day - first_day).days == 1:
                    yield event(
                        s, "ECB monetary policy meeting", "欧洲央行货币政策会议", first_day, end=day
                    )
                first_day = None
                yield event(
                    s,
                    "ECB monetary policy decision",
                    "欧洲央行货币政策决定",
                    day,
                    clock=time(14, 15),
                    time_source_url="https://www.ecb.europa.eu/press/govcdec/html/index.en.html",
                )
        elif (zh := family(details.split("(Dataset:")[0])) is not None:
            yield event(
                s,
                details.split("Reference period:")[0].removesuffix("Tentative").strip(),
                zh,
                day,
                clock=clock(stamp[4] or ""),
                status="provisional"
                if "Tentative" in text(dt) or "Tentative" in details
                else "finalised",
            )


def _estat_labels(group, title):
    name = normalize("NFKC", title)
    combined = normalize("NFKC", group + " " + title)
    stage = []
    for token, en, zh in [
        ("基本集計", "basic tabulation", "基本统计"),
        ("詳細集計", "detailed tabulation", "详细统计"),
        ("中旬速報", "mid-month preliminary", "月中初值"),
    ]:
        if token in combined:
            stage.append((en, zh))
    quarter = re.search(r"(\d{4})年(\d{1,2})[~〜](\d{1,2})月期平均", name)
    annual = re.search(r"(\d{4})年(度?)平均", name)
    monthly = re.search(r"(\d{1,2})月分", name)
    year = re.search(r"(\d{4})年", name) or re.search(r"(\d{4})年", combined)
    if quarter:
        y, start, end = map(int, quarter.groups())
        stage.append(
            (f"{month_name[start]}–{month_name[end]} {y} average", f"{y}年{start}至{end}月平均")
        )
    elif annual:
        stage.append(
            (
                f"{annual[1]} fiscal-year average" if annual[2] else f"{annual[1]} annual average",
                annual[1] + ("财年平均" if annual[2] else "年平均"),
            )
        )
    elif monthly and year and "遡及" not in name:
        stage.append(
            (f"{month_name[int(monthly[1])]} {year[1]}", f"{year[1]}年{int(monthly[1])}月")
        )
    else:
        # Preserve uncommon publisher labels such as retrospective rebasing.
        stage.append((title, title))
    return ", ".join(en for en, _ in stage), "，".join(zh for _, zh in stage)


def estat(s, root):
    for table in root.xpath("//table[@class='detail_list_table-layout']"):
        group = ""
        for row in table.xpath(".//tr"):
            header = row.xpath(".//div[@class='detail_list_header']")
            if header:
                group = text(header[0])
            raw = row.xpath(".//ul[li[1]='公表日']/li[2]")
            title = row.xpath(".//div[@class='detail_list_title']")
            if not raw or not title:
                continue
            m = re.fullmatch(r"(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?", text(raw[0]))
            if not m:
                continue
            if s.key == "estat-cpi":
                if "全国" in group:
                    en, zh = "National CPI", "全国消费者价格指数"
                elif "東京都区部" in group:
                    en, zh = "Tokyo CPI", "东京消费者价格指数"
                else:
                    continue
            elif s.key == "estat-labour":
                en, zh = "Labour force survey", "劳动力调查"
            elif "確報" in group + text(title[0]):
                en, zh = "Industrial production (revised)", "工业生产（修正值）"
            else:
                en, zh = "Industrial production (preliminary)", "工业生产（初值）"
            period_en, period_zh = _estat_labels(group, text(title[0]))
            yield event(
                s,
                f"{en} ({period_en})",
                f"{zh}（{period_zh}）",
                date.fromisoformat(m[1]),
                clock=clock(m[2] or ""),
                identity=(group, text(title[0])),
            )


def cao(s, root):
    for row in root.xpath("//tr[td]"):
        c = cells(row)
        if len(c) != 3:
            continue
        m = re.fullmatch(r"[A-Za-z]+,\s*([A-Za-z]+) (\d{1,2}),\s*(\d{4})", c[1])
        if m and "JST" in c[2]:
            zh = (
                "国内生产总值（第二次初值）"
                if "Second" in c[0]
                else "国内生产总值（初值）"
                if "First" in c[0]
                else "年度国内生产总值"
            )
            yield event(
                s,
                "GDP: " + c[0],
                zh,
                date(int(m[3]), month(m[1]), int(m[2])),
                clock=clock(c[2].split("(")[0].strip()),
                identity=c[0],
            )


def boj(s, root):
    for table in root.xpath("//table[caption]"):
        year = re.search(r"\b(20\d\d)\b", text(table.xpath("caption")[0]))
        if not year:
            continue
        for row in table.xpath(".//tr[td]"):
            m = re.match(
                r"([A-Za-z]+)\.?\s+(\d{1,2})\s*\([^)]+\),\s*(?:([A-Za-z]+)\.?\s+)?(\d{1,2})\s*\(",
                cells(row)[0],
            )
            if m:
                first = date(int(year[1]), month(m[1]), int(m[2]))
                last = date(int(year[1]), month(m[3] or m[1]), int(m[4]))
                yield event(
                    s,
                    "Bank of Japan monetary policy meeting",
                    "日本央行货币政策会议",
                    first,
                    end=last,
                )
                yield event(s, "Bank of Japan policy decision", "日本央行政策决定", last)


def mods(s, root):
    headings = root.xpath("//h3[contains(.,'보도계획')]")
    year = re.search(r"(20\d\d)년", " ".join(text(h) for h in headings)) if headings else None
    if not year:
        return
    for row in root.xpath("//tr[@class='tr-notice']"):
        c = cells(row)
        if len(c) < 3:
            continue
        m = re.match(r"(\d{1,2})\.(\d{1,2})\.", c[0])
        for name, en, zh in [
            ("소비자물가동향", "Consumer prices", "消费者价格指数"),
            ("고용동향", "Employment trends", "就业趋势"),
            ("산업활동동향", "Industrial activity", "工业活动"),
        ]:
            if m and name in c[2]:
                yield event(
                    s,
                    en,
                    zh,
                    date(int(year[1]), int(m[1]), int(m[2])),
                    clock=clock(c[1]),
                    identity=c[2],
                )


def bok(s, root):
    for table in root.xpath("//table"):
        h = table.xpath("preceding::h3[1]")
        section = table.xpath("preceding::h2[1]")
        if (
            not h
            or not section
            or "policy-setting meetings" not in text(section[0])
            or not re.fullmatch(r"20\d\d", text(h[0]))
        ):
            continue
        for cell in table.xpath(".//td"):
            m = re.fullmatch(r"([A-Za-z]+)\.\s*(\d{1,2})\s*\([^)]+\)", text(cell))
            if m:
                yield event(
                    s,
                    "Monetary Policy Board decision",
                    "韩国央行货币政策决定",
                    date(int(text(h[0])), month(m[1]), int(m[2])),
                )


PARSERS = {
    "census": census,
    "fred": fred,
    "fomc": fomc,
    "fedmonth": fedmonth,
    "boe": boe,
    "ecb": ecb,
    "ecbstats": ecb,
    "estat": estat,
    "cao": cao,
    "boj": boj,
    "mods": mods,
    "bok": bok,
}


def parse_html(source, content):
    tree = html.fromstring(content.decode("utf-8-sig"), parser=html.HTMLParser(no_network=True))
    rows = list(PARSERS[source.parser](source, tree))
    if not rows:
        # An official monthly calendar or scoped release list may legitimately
        # contain no policy meeting or release in the requested window.
        if (
            source.parser == "fedmonth"
            and tree.xpath("//title[contains(.,'Calendar:')]")
            and tree.xpath("//div[@class='col-xs-7']")
        ):
            return []
        if source.parser == "fred" and "0 economic release dates" in " ".join(
            tree.xpath("//meta[@name='description']/@content")
        ):
            return []
        raise ValueError("no recognised calendar rows")
    return rows
