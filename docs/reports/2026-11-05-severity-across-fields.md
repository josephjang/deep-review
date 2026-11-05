# Report: How other fields grade severity, and what a review can take from them

This report was written on 2026-11-05, on the branch of pull request #121, after the first gate of its rubric for the severity of a finding. The gate showed that a rubric of three severities, each defined by a few consequences in words, does not give a ranker values it can apply the same way twice. The report asks three questions. How do fields that grade defects or risks for a living make a grade repeatable? How does a grade look from the points of view that read a review: the product, the system, security and performance, and the author, the reviewer and the owner of the repository? What structure of a severity follows for deep-review?

## Summary

- The first rubric named consequences for each severity and settled a case between two by asking whether a reviewer would hold the merge. Its gate graded the same consequence two ways in one run (four public leaks of a secret, one `critical` and three `major`), moved two different defects of one change together, and met classes of defect that none of its tests covers, such as a cost a user pays while every result is right. Every `reason` named a consequence, but none could say which value of which test gave the grade, since the rubric had no values.
- Fields that grade defects repeatably share one structure. They grade a defect on a few axes, each answered by a fact: how bad the harm is, how often or how easily it is met, and whether the harm can be noticed, controlled or undone. ISO 26262 grades severity, exposure and controllability; FMEA grades severity, occurrence and detection; CVSS separates exploitability from impact and adds a measure of recovery.
- They combine the axes by a table, not by arithmetic. The automotive FMEA handbook of 2019 replaced the product of its three ratings by a table of action priority, and Microsoft replaced the DREAD score by a bug bar, each because the earlier score was not consistent.
- They keep the grade of the harm apart from what to do about it. Mozilla's Bugzilla has a severity and a priority; SSVC turns facts into an action that depends on who decides. Code review labels the decision, blocking or not, and not the harm. deep-review's severity does both jobs in one word, which is why its tie question reads as a feeling.
- Severity labels given by feel disagree: in a study of three bug trackers, about half the pairs of duplicate reports of one bug carried different severities. And about three in four defects that code review finds do not affect what the software visibly does, so a review whose findings are mostly minor is normal; what matters is a line between minor and major that is drawn the same way every time.
- The report proposes that merge-rank give each finding three values, its effect, its reach and its recovery, each defined by a fact with one example, and read the severity from a table, with one step up or down for recovery. Whether the change introduced the defect is recorded beside them and decides no severity. Applied to the cases of the gate, the structure grades the four leaks alike and separates the two defects that moved together.

## Data and method

### Sources

The sources outside this repository are public:

- ISO 26262-3, the hazard analysis of road vehicles, as summarized in [Understanding ISO 26262 ASILs](https://www.electronicdesign.com/technologies/embedded/article/21798166/understanding-iso-26262-asils) and [Agonising Over ASILs](https://www.proteanelectric.com/f/2018/04/Agonising_Over_ASILS.pdf).
- The AIAG and VDA FMEA handbook of 2019, as summarized in [Quality Digest](https://www.qualitydigest.com/inside/lean-article/aiagvda-s-fmea-manual-major-advance-010220.html) and [Action Priority in new FMEA](https://eprints.uklo.edu.mk/id/eprint/6566/1/Action%20Priority%20in%20new%20FMEA%20as%20factor%20for%20Resources%20Management%20in%20Risk%20Reduction.pdf).
- The [Microsoft SDL security bug bar](https://learn.microsoft.com/en-us/security/sdl/security-bug-bar-sample) and its history in [MSDN Magazine, March 2010](https://msdn.microsoft.com/en-us/magazine/3eee8612-bab6-4584-8ad3-caa15b2b5b4d).
- The [Chromium severity guidelines for security issues](https://chromium.googlesource.com/chromium/src/+/master/docs/security/severity-guidelines.md).
- CVSS v4.0, as summarized in [BleepingComputer](https://www.bleepingcomputer.com/news/security/new-cvss-40-vulnerability-severity-rating-standard-released/) and [Hackread](https://www.hackread.com/cvss-v4-0-supplemental-metrics-ot-ics-iot-support/), and SSVC, in the [CISA SSVC guide](https://us-cert.gov/sites/default/files/publications/cisa-ssvc-guide%20508c.pdf) and the [CERT/CC documentation](https://certcc.github.io/SSVC/topics).
- SonarQube's [software qualities](https://docs.sonarsource.com/sonarqube-server/quality-standards-administration/managing-rules/software-qualities) and [MQR mode](https://docs.sonarsource.com/sonarqube-community-build/instance-administration/analysis-functions/instance-mode/mqr-mode/).
- IBM's [Orthogonal Defect Classification](https://en.wikipedia.com/wiki/Orthogonal_Defect_Classification), from Chillarege et al., IEEE Transactions on Software Engineering, 1992.
- Mozilla's [DOM triage](https://wiki.mozilla.org/DOM/Triage) and [release engineering triage](https://moz-releng-docs.readthedocs.io/en/latest/best-practices/bug-triage.html), and Atlassian's [incident severity levels](https://www.atlassian.com/incident-management/kpis/severity-levels).
- [Conventional Comments](https://conventionalcomments.org/) and Google's [guide to writing review comments](https://google.github.io/eng-practices/review/reviewer/comments.html) and [standard of code review](https://google.github.io/eng-practices/review/reviewer/standard.html).
- Tian, Ali, Lo and Hassan, [On the unreliability of bug severity data](https://sail.cs.queensu.ca/data/pdfs/EMSE2015_OnTheUnreliabilityOfBugSeverityData.pdf), Empirical Software Engineering, 2015; Mäntylä and Lassenius, [What types of defects are really discovered in code reviews?](https://mmantyla.github.io/wiki/What+Types+of+Defects+Are+Really+Discovered+in+Code+Reviews%253F.html), IEEE Transactions on Software Engineering, 2009, and its [re-evaluation of 2022](https://link.springer.com/10.1007/s10664-022-10205-7).

The sources in this repository are the proposal [A rubric for the severity of a finding](../changes/2026-11-05-severity-rubric.md), its rubric in `roles/fragments/phase4-list.md`, and the three runs of its gate: a review of #121 itself on Claude Code (run `00c38609`), a review again of the change of #96 on Claude Code (run `273e6cf1`, against run `b856cf6f` that the gate of the review on the pull request posted), and a review again of deep-review/click#1 on Codex (run `3ecba59f`, against run `760e63d8`). The reports of the three runs are kept by the author outside the repository; the counts below are theirs.

### Method

Each field's standard was read for what it grades a defect on, how it combines the parts into one grade, and what it keeps apart from the grade. The findings of the gate's two runs again were paired with the findings of the first reviews of the same changes by their location and their summary, and every `reason` of the new runs was read against the tests of the rubric. Each point of view of section "Seven points of view" was read against the first rubric and against the structure of section "A structure for the severity".

### Limits

Several standards were read in public summaries, not in their text: ISO 26262 and the AIAG and VDA handbook are sold, and the report does not reproduce their tables. CVSS v4.0 was read in summaries of its release. The gate is three runs, two of them on changes reviewed before, and two runs of one change do not find the same set, so its counts compare distributions and pairs, not a rubric alone. The structure of section "A structure for the severity" has not run; how it grades the gate's cases is the author's reading of their evidence.

## What the first rubric showed

The first rubric defines `critical` as a harm that reaches every user or cannot be undone, `major` as a wrong result, a broken contract or a failure on a path the change's users reach, and `minor` as a cost on the next reader or the next change, each with one example. A finding between two is settled by whether a reviewer who knew of it would hold the merge.

| Run | Before (critical, major, minor) | After | Pairs, and pairs whose severity moved |
|---|---|---|---|
| #121, Claude Code | | 16: 0, 4, 12 | |
| #96 again, Claude Code | 30: 0, 11, 19 | 33: 1, 17, 15 | 10, none moved |
| click#1 again, Codex | 18: 0, 6, 12 | 17: 0, 6, 11 | 14, two moved from minor to major |

### G1: One consequence, two grades

The review of #96 again holds four findings whose consequence is a secret posted in public on the pull request: a private key in a form the cleaning does not know (1), a token that the reviewed code can read (12), a secret only the review's environment held (17), and secrets of names the cleaning does not match (18). The first is `critical` as "a security hole that cannot be undone"; the other three are `major`, one of them with the words "the leak is public and cannot be undone". Two findings whose consequence is a review posted twice on the pull request, which GitHub does not let anyone take back, are `major` as well (13, 16). The rubric's `critical` names "cannot be undone" and "a hole in security", and a model applied each phrase to some findings and not to others.

### G2: Two different defects move together

In click#1, the first review graded `minor` a prompt that does not show the caret echo its documentation promises, and a prompt interrupted by end of input that leaves the echo paused for the rest of the run. The second run graded both `major`. The first is met by any test that gives a prompt a control byte, which the change documents; the second only by a command that catches the abort of a prompt and reads on. The rubric has no value that says how a defect is met, so it cannot grade the two apart, and the tie question moves them together.

### G3: Classes that no test covers

The review of #121 asked how to grade a cost that users pay at run time while every result is right, since none of the three tests names it, and the review of #96 again graded `major` a writer that a narrowed run pays for and no command can show, on "real wasted cost". The rubric's tests are about results, contracts and readers; a cost in time or money, and a slowdown, fall between them.

### G4: The tie question is a feeling

"Would a reviewer who knew of it hold the merge" is the decision that the severity feeds, asked back as the test of the severity. It reads the grade from the grade's use, and two runs, or two models, answer it from their own sense of a reviewer. The review of #121 also found that the question can answer only `major` or `minor`, so a finding between `critical` and `major` always comes out `major`.

### G5: A reason names a consequence, not a value

Every `reason` of the two runs again named a consequence: 33 of 33 on #96 and 17 of 17 on click#1. One of the 33 named a consequence outside the rubric's tests (the wasted cost of G3), and one lowered a grade because "the change does not create it", which the rubric says decides no severity. Three repeated the words of `minor`'s example, each on a helper that the change does copy. A reader can check that a reason names a consequence, but not that the consequence gives the grade, since the rubric maps no consequence to a value.

## How other fields grade

### F1: Safety and quality fields grade on three axes

ISO 26262 grades each hazardous event of a road vehicle on severity (S0, no injuries, to S3, fatal), exposure (E0, incredible, to E4, high probability) and controllability (C0 to C3, whether a driver can avoid the harm), and reads its integrity level, from QM, no safety measure, to ASIL D, from the three. FMEA grades each failure mode on severity, occurrence and detection. Each axis asks one question that a fact answers, and the axes do not overlap: how bad the harm is, how often or how easily it is met, and whether it can be caught or controlled before it does harm.

### F2: They combine the axes by a table

ISO 26262 reads the integrity level from a table of the three classes. The AIAG and VDA handbook of 2019 replaced FMEA's risk priority number, the product of its three ratings, by a table of action priority, which weighs severity first, then occurrence, then detection; the product had been criticized for weighing detection as much as harm. Microsoft's security bug bar replaced the DREAD score, which its teams judged too inconsistent, by a classification in which the filer picks the kind of threat and the triager reads the severity from a table by its scope. A table can be read, argued with and changed cell by cell; a product of ordinal ratings cannot.

### F3: Security grades the harm, then lowers it for preconditions

Chromium grades a security bug by what an attacker gains, then lowers it for mitigating factors: a renderer sandbox escape has the impact of a critical bug but is high, since it needs a compromised renderer first, and memory corruption that needs specific user interaction is medium. A bug that applies only to one platform is not lowered for it. Microsoft's server table lowers a critical bug that needs user interaction to important. CVSS keeps exploitability (the attack vector, its complexity, the privileges and the user interaction it needs) apart from impact, and version 4.0 adds supplemental measures, among them recovery: automatic, by the user, or irrecoverable.

### F4: A severity is per quality, or the quality is its own attribute

SonarQube's mode of software qualities gives each rule a severity for each quality it affects, security, reliability and maintainability, instead of one severity for the quality it affects most. IBM's Orthogonal Defect Classification records a defect's impact as the quality that suffers (capability, reliability, performance, security, usability and others), its trigger as the condition under which it shows, and its age as whether the code was new, rewritten or older, each as a separate attribute that grades nothing.

### F5: The grade of the harm and the decision are separate

Mozilla's Bugzilla gives a bug a severity, S1 to S4, defined by data loss, the share of users affected and whether a workaround exists, and a priority, which the triager sets with the severity as one input. SSVC goes further: it does not score a vulnerability but walks a tree of decision points to an action, Track, Track*, Attend or Act, and the tree differs for a supplier, a deployer and a coordinator, so two of them can rightly decide differently on one vulnerability. Atlassian's incident severities rest on the harm and its breadth: a data loss, a breach or a service down for every customer is SEV1, and a service down for some customers is SEV2.

### F6: Code review labels the decision

Conventional Comments marks a comment `blocking` or `non-blocking`, and says that a nitpick is non-blocking by nature. Google's guide asks a reviewer to label the weight of a comment, such as "Nit:" for one that should be addressed but will not hugely affect things, so that the author can tell required changes from suggestions. Neither grades how bad a defect is; each says what the comment does to the merge.

### F7: Labels by feel disagree

Tian, Ali, Lo and Hassan compared the severities that reporters gave to duplicate reports of one bug in the trackers of OpenOffice, Mozilla and Eclipse, and found about 51 percent of the pairs inconsistent. A severity chosen whole, by a person's sense of the words, is a noisy label.

### F8: Most of what review finds is not visible behavior

Mäntylä and Lassenius found that about 75 percent of the defects that code reviews found do not affect the visible functionality of the software, and improve its evolvability instead; later studies of open source systems found the same split. A review whose findings are mostly minor is the common case, and the line between minor and major is the one that decides what a reader sees.

## Seven points of view

### V1: The product

A product owner asks what a user can no longer do, how many users meet it, and whether there is a workaround: Mozilla's S1 to S3 turn on exactly these. The first rubric asks the first, partly the second through "a path its users reach", and never the third.

### V2: The system

An engineer of the system asks how far the harm spreads, whether it heals by itself, and whether someone must act to undo it: CVSS's impact on subsequent systems and its recovery measure, and the breadth of Atlassian's SEV levels. The first rubric folds "cannot be undone" into `critical`, so irreversibility, a property of recovery, is read as a size of harm, which is G1.

### V3: Security

A security engineer asks what is lost, confidentiality, integrity or availability, and who can make it happen: an attacker from outside, a user who must act, or only an operator. Chromium and Microsoft lower a grade for preconditions and user interaction. The first rubric names "a hole in security" and says nothing of who can trigger it, so a leak that any worker's quote can cause and one that needs code under review to call `gh` read alike.

### V4: Performance

A performance engineer asks how much slower, against what expectation, whether the cost grows with input faster than it should, and whether the path is hot. A useful rubric names a bound: a budget or timeout that the code or its documents state, or a change of complexity class. The first rubric has no place for a slowdown (G3), and "noticeably slower" would be a feeling again.

### V5: The author

The author of the change wants to know what holds the merge and why, and to be able to dispute a grade. A grade whose reason names the value of each axis and its fact can be disputed on a fact; a grade whose reason names a consequence can be disputed only on a judgment. The size of the fix, which the author pays, must decide no grade, as the first rubric already says.

### V6: The reviewer

A reviewer wants the same defect graded the same way every time, and asks whether the change made the defect or found it there. Google's standard approves a change that improves the health of the code even if it is not perfect, so a defect that the change only exposes is often not a reason to hold it. The first rubric says that the age of the code decides no severity, and a ranker of the gate lowered a grade on that ground anyway (G5), which shows the reviewer's question asking to be answered somewhere.

### V7: The owner

The owner of the repository decides which risks the repository accepts: SSVC's point that the decision depends on who decides, and principle 4 of the vision note, that a person writes the rules. Which cells of a table hold the merge is such a rule. Today the engine fixes it, and a repository cannot state its own; the report on preferences and policies deferred a severity floor (D3).

## A structure for the severity

### S1: Three values, each a fact

Merge-rank gives each finding three values, each with a definition that a fact of the finding's evidence answers and one example.

- Effect, what happens when the defect occurs: `loss`, data is lost or corrupted, or a secret or private data reaches someone who must not have it; `wrong`, a caller gets a wrong result, a contract it relies on breaks, or an operation the change promises fails, by an error, a refusal, a hang or a cost past a bound that the code or its documents state; `degraded`, the caller still reaches the right outcome at a cost, such as a misleading message, a missing next step or work slower than it needs to be within any stated bound; `none`, the behavior is right and the cost falls on the next reader or the next change.
- Reach, who meets it: `always`, every use of what the change adds or alters; `ordinary`, a use that the documents, the tests or a caller in the repository make, under a condition such as an option, an input or a failure from outside, with input that an outside party controls counted as ordinary; `contrived`, only an input or a sequence that no documented use makes, or a later change.
- Recovery, what follows once it has happened: `visible`, the person who meets it sees it at once and can undo it or work around it alone; `operator`, it is seen, but undoing it needs a maintainer, an operator or a fix; `silent`, no one is told, or it cannot be undone.

The quality that suffers (F4) helps choose the effect, a slowdown is `degraded` until it passes a bound and `wrong` after, and is not a fourth value: the form reads one severity per finding, and a fourth value would have no reader.

### S2: A table, and one step for recovery

The severity is read from effect and reach, then moved one step by recovery.

| Effect \ Reach | always | ordinary | contrived |
|---|---|---|---|
| loss | critical | critical | major |
| wrong | critical | major | minor |
| degraded | major | minor | minor |
| none | minor | minor | minor |

`silent` raises the grade one step and `visible` lowers it one step; `operator` leaves it. A finding whose effect is `degraded` never reaches `critical`, and one whose effect is `none` stays `minor`. When two values of an axis both fit, the ranker takes the lower and names the other in the reason. The cells are a judgment of the author, which the gate measures, as ISO 26262 and the FMEA handbook each fix theirs.

### S3: The origin recorded, not graded

The reason also says whether the change introduced the defect, made it worse, or found it there, as ODC records age (F4). It decides no severity, since the severity is the harm, not the decision (F5). Whether a defect that the change did not introduce stays out of what matters before the merge is the reviewer's question of V6 and a change of the form, for a proposal of its own.

### S4: The reason names each value

Each finding's `reason` names its effect, reach and recovery, each with the fact that gives it, and its origin. A reader of the ledger can then check the severity against the table without asking the ranker, and a gate can count the reasons whose values and severity disagree with the table, a measure of consistency that the first rubric could not have.

### S5: What stays

The three severities and the engine's order stay, and so do the posted words of `severityMeanings`, which call a wrong message or repeated code minor: under the table a wrong message is `degraded` and repeated code is `none`, both `minor` at ordinary reach unless they are silent. What a severity is not graded by stays: how sure the verdict is, how large the fix would be, which angle found the finding and how old the code is. A `CONVENTIONS` violation takes its effect from what the rule's own reason says goes wrong, and `none` when the rule states no reason and breaking it breaks no behavior.

### Applied to the cases of the gate

| Case | Effect, reach, recovery | Severity |
|---|---|---|
| #96 again, 1, 12, 17, 18: a secret posted in public | loss, ordinary, silent | critical, all four |
| #96 again, 13 and 16: a review posted twice after a timeout or a stray 4xx | wrong, contrived, silent | major |
| click#1, caret echo not shown at a prompt, as documented | wrong, ordinary, operator | major |
| click#1, echo left paused after an interrupted prompt | wrong, contrived, operator | minor |
| #121, a run-time cost while results are right | degraded, then wrong past a stated bound | by the table |

## Ways to improve

1. Amend the proposal of #121: replace the three tests and the tie question of R1 by the values and the table of S1 and S2, record the origin of S3 beside them, and ask the reason of S4. This changes merge-rank's role prompt again.
2. Run the gate again with the second rubric on the same three changes, and count, besides the severities and the pairs, the reasons whose values and severity disagree with the table.
3. If the gate counts many such disagreements, record the three values as fields of the ranking and have the engine read the severity from the table. That is a new version of `ranking.recorded` and its own proposal.
4. Let a defect that the change did not introduce stay out of what matters before the merge, as the reviewer of V6 asks: a change of the form, for a proposal of its own.
5. Let a repository state its own table, or the cells that hold the merge, as the owner of V7 decides, with the severity floor that the report on preferences and policies deferred (D3).

## Related

- [A rubric for the severity of a finding](../changes/2026-11-05-severity-rubric.md), the proposal of #121, and its gate (R6).
- [How the review on a pull request is written and read](2026-11-05-review-written-and-read.md), whose W1 names the severity as the largest judgment of the review without a stated rule.
- [Preferences and policies](2026-10-16-preferences-and-policies.md), whose D3 deferred a severity floor.
- [The vision note of 2026-11-05](../2026-11-05-vision.md), principles 1, 4, 6, 10 and 12.
- Issue #102, on how the body of the first review of #96 weighs its findings.
