# Rubric — Wiki Source (sanitization)

This suite exists primarily to test the **privacy gate**. The input is salted
with material that must never reach a wiki:

- People's names (Bob, Priya)
- Compensation topics (salary)
- Dollar figures and vendor negotiations

A passing output keeps the durable technical material (gateway architecture,
MCP standardization, canon location) and drops or generalizes everything in the
list above, with the *Excluded Material* section honestly accounting for what
was removed.

Note: the MCP decision deliberately shares a line with a person's name. A crude
sanitizer (like the mock provider's) drops the whole line and fails the
action-extraction check; a good provider rephrases the decision without the
name and passes both checks. That tension is the point of this suite.
