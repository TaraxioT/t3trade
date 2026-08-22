# P11a: real panel computed-style dump (web harness, port 5799)

Source: `apps/web` harness rendering the unmodified `MissionLivePanel` against fixtures. Captured at deviceScaleFactor 2, dark theme. Values are `getComputedStyle` output.

## app-1440 (viewport 1440px)

| surface | element | font-family | font-size | font-weight | border-radius | border-color | background-color | backdrop-filter | color | rendered text (head) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mission panel container | `div` | -apple-system (stack) | 16px | 400 | 0px | oklab(0.999994 0.0000455678 0.0000200868 / 0.06) | rgba(0, 0, 0, 0) | none | oklch(0.97 0 0) | ETH · USD / 1,869.4 / +1.84% / 1m / ◷ / reassess / 1,860 / 1,870 / 1,880 / 1,878.2 / target / ○ ▲ / 1,878 / above / ✓ ▲ / 1,873.5 / above / 1,869.4 / 1,864. |
| chart card | `div` | -apple-system (stack) | 16px | 400 | 0px | oklab(0.999994 0.0000455678 0.0000200868 / 0.06) | rgba(0, 0, 0, 0) | none | oklch(0.97 0 0) | ETH · USD / 1,869.4 / +1.84% / 1m / ◷ / reassess / 1,860 / 1,870 / 1,880 / 1,878.2 / target / ○ ▲ / 1,878 / above / ✓ ▲ / 1,873.5 / above / 1,869.4 / 1,864. |
| log row | `div` | -apple-system (stack) | 16px | 400 | 0px | oklab(0.999994 0.0000455678 0.0000200868 / 0.06) | rgba(0, 0, 0, 0) | none | oklch(0.97 0 0) | AGENT LOG /  / +1.39% / +$2.60 |
| level chip | `span` | ui-monospace (stack) | 10.5px | 400 | 3.35544e+07px | oklab(0.999994 0.0000455678 0.0000200868 / 0.03) | color(srgb 0.0681953 0.0682112 0.0682127 / 0.62) | blur(8px) | oklab(0.78 0.025989 0.122268 / 0.85) | ○ ▲ / 1,873.5 / above |
| header capsule | `button` | -apple-system (stack) | 14px | 400 | 3.35544e+07px | oklab(0.999994 0.0000455678 0.0000200868 / 0.06) | rgba(0, 0, 0, 0) | none | oklch(0.97 0 0) | ETH / Long 0.5 / +$2.60 |
| status bar | `div` | -apple-system (stack) | 16px | 400 | 14px | rgba(255, 255, 255, 0.12) | color(srgb 0.0681953 0.0682112 0.0682127 / 0.58) | blur(16px) saturate(1.08) | oklch(0.97 0 0) | Holding long / Plan / next 12m 51s / → 1,912 by 2:41 AM / Held 12m 11s |
| positions row | `div` | -apple-system (stack) | 16px | 400 | 0px | oklab(0.999994 0.0000455678 0.0000200868 / 0.06) | rgba(0, 0, 0, 0) | none | oklch(0.97 0 0) | POSITIONS /  / UNREALISED / +1.39% / +$2.60 |

### Numeric fields (app-1440)

- mark price chip (`mission-chart-mark`): `1,869.4`
- status bar full text: <code>Holding long / Plan / next 12m 51s / → 1,912 by 2:41 AM / Held 12m 11s</code>
- positions block (head 400 chars): <code>POSITIONS /  / UNREALISED / +1.39% / +$2.60 / STATE / ENTRY / EXIT / SIZE · $ / USD / TIME / ETH / 5x / Long / OPEN / 1,864.2 / $932 / +$2.29 / 12m ago / ETH / 5x / Long / WORKING / 1,858.1 / $929 / - / 11m ago</code>

<details><summary>panel innerText head</summary>

```
ETH · USD
1,869.4
+1.84%
1m
◷
reassess
1,860
1,870
1,880
1,878.2
target
○ ▲
1,878
above
✓ ▲
1,873.5
above
1,869.4
1,864.2
entry
1,858.1
stop
+2
-$6.00
+$7.00
1.2:1 planned

POSITIONS

UNREALISED
+1.39%
+$2.60
STATE
ENTRY / EXIT
SIZE · $
USD
TIME
ETH
5x
Long
OPEN
1,864.2
$932
+$2.29
12m ago
ETH
5x
Long
WORKING
1,858.1
$929
-
11m ago

AGENT LOG

+1.39%
+$2.60
37% to target
watch armed:
▼ETH mark crosses below 1,858.1
1,858.1
8m ago
watch armed:
▲ETH 1m candle closes above 1,878
1,878
8m ago
watch armed:
▼ETH unrealised PnL falls to -$4.00
-$4.00
7m ago
watch fired:
▲ETH mark crosses above 1,873.
```
</details>

## app-390 (viewport 390px)

| surface | element | font-family | font-size | font-weight | border-radius | border-color | background-color | backdrop-filter | color | rendered text (head) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mission panel container | `div` | -apple-system (stack) | 16px | 400 | 0px | oklab(0.999994 0.0000455678 0.0000200868 / 0.06) | rgba(0, 0, 0, 0) | none | oklch(0.97 0 0) | ETH · USD / 1,869.4 / +1.84% / 1m / ◷ / reassess / 1,860 / 1,870 / 1,880 / 1,878.2 / target / ○ ▲ / 1,878 / above / ✓ ▲ / 1,873.5 / above / 1,869.4 / 1,864. |
| chart card | `div` | -apple-system (stack) | 16px | 400 | 0px | oklab(0.999994 0.0000455678 0.0000200868 / 0.06) | rgba(0, 0, 0, 0) | none | oklch(0.97 0 0) | ETH · USD / 1,869.4 / +1.84% / 1m / ◷ / reassess / 1,860 / 1,870 / 1,880 / 1,878.2 / target / ○ ▲ / 1,878 / above / ✓ ▲ / 1,873.5 / above / 1,869.4 / 1,864. |
| log row | `div` | -apple-system (stack) | 16px | 400 | 0px | oklab(0.999994 0.0000455678 0.0000200868 / 0.06) | rgba(0, 0, 0, 0) | none | oklch(0.97 0 0) | AGENT LOG /  / +1.39% / +$2.60 |
| level chip | `span` | ui-monospace (stack) | 10.5px | 400 | 3.35544e+07px | oklab(0.999994 0.0000455678 0.0000200868 / 0.03) | color(srgb 0.0681953 0.0682112 0.0682127 / 0.62) | blur(8px) | oklab(0.78 0.025989 0.122268 / 0.85) | ○ ▲ / 1,873.5 / above |
| header capsule | `button` | -apple-system (stack) | 14px | 400 | 3.35544e+07px | oklab(0.999994 0.0000455678 0.0000200868 / 0.06) | rgba(0, 0, 0, 0) | none | oklch(0.97 0 0) | ETH / Long 0.5 / +$2.60 |
| status bar | `div` | -apple-system (stack) | 16px | 400 | 14px | rgba(255, 255, 255, 0.12) | color(srgb 0.0681953 0.0682112 0.0682127 / 0.58) | blur(16px) saturate(1.08) | oklch(0.97 0 0) | Holding long / Plan / next 12m 50s / → 1,912 by 2:41 AM / Held 12m 12s / Funding 0.0013%/8h |
| positions row | `div` | -apple-system (stack) | 16px | 400 | 0px | oklab(0.999994 0.0000455678 0.0000200868 / 0.06) | rgba(0, 0, 0, 0) | none | oklch(0.97 0 0) | POSITIONS /  / +1.39% / +$2.60 |

### Numeric fields (app-390)

- mark price chip (`mission-chart-mark`): `1,869.4`
- status bar full text: <code>Holding long / Plan / next 12m 50s / → 1,912 by 2:41 AM / Held 12m 12s / Funding 0.0013%/8h</code>
- positions block (head 400 chars): <code>POSITIONS /  / +1.39% / +$2.60 / STATE / ENTRY / EXIT / SIZE · $ / USD / TIME / ETH / 5x / Long / OPEN / 1,864.2 / $932 / +$2.29 / 12m ago / ETH / 5x / Long / WORKING / 1,858.1 / $929 / - / 11m ago</code>

<details><summary>panel innerText head</summary>

```
ETH · USD
1,869.4
+1.84%
1m
◷
reassess
1,860
1,870
1,880
1,878.2
target
○ ▲
1,878
above
✓ ▲
1,873.5
above
1,869.4
1,864.2
entry
1,858.1
stop
+2
-$6.00
+$7.00
1.2:1 planned

POSITIONS

+1.39%
+$2.60
STATE
ENTRY / EXIT
SIZE · $
USD
TIME
ETH
5x
Long
OPEN
1,864.2
$932
+$2.29
12m ago
ETH
5x
Long
WORKING
1,858.1
$929
-
11m ago

AGENT LOG

+1.39%
+$2.60
37% to target
watch armed:
▼ETH mark crosses below 1,858.1
1,858.1
8m ago
watch armed:
▲ETH 1m candle closes above 1,878
1,878
8m ago
watch armed:
▼ETH unrealised PnL falls to -$4.00
-$4.00
7m ago
watch fired:
▲ETH mark crosses above 1,873.5
1,873.5
0
```
</details>

