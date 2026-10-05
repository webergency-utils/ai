import { question, Workflow, type DecisionModel, type DecisionAnswers } from '../../../src/index.js';

declare const model: DecisionModel;

const questions = {
    team    : question.choice( { billing : 'Payments', technical : null, other : null } ),
    listed  : question.choice( [ 'a', 'b' ] ),
    urgency : question.score( [ 'low', 'high' ] ),
    refund  : question.yesNo()
};

async function main(): Promise<void>
{
    const { answers } = await model.decide( { input : 'text', questions } );

    // Choice values are the union of the labels (AE1).
    const team: 'billing' | 'technical' | 'other' = answers.team.value;
    const listed: 'a' | 'b' = answers.listed.value;
    const urgency: number = answers.urgency.value;
    const refund: number = answers.refund.value;
    const levels: readonly number[] = answers.urgency.probabilities;
    const billingProbability: number = answers.team.probabilities.billing;
    const confidence: number = answers.team.confidence;

    void [ team, listed, urgency, refund, levels, billingProbability, confidence ];

    // @ts-expect-error misspelled label
    if( answers.team.value === 'bililng' ) { void 0; }

    // @ts-expect-error a score answer is a number, not a label
    const bad: string = answers.urgency.value;

    // @ts-expect-error unknown label has no probability
    void answers.team.probabilities.refund;

    // @ts-expect-error unknown question name
    void answers.missing;

    void bad;
}

void main;

// Decision-step routing: the router can return only declared branches.
type Answers = DecisionAnswers<typeof questions>;

new Workflow( 'typed' )
    .decision( 'triage', {
        model,
        questions,
        input    : 'x',
        branches : { billing : 'a', technical : 'b' },
        route    : ( answers: Answers ) => { return answers.team.value === 'billing' ? 'billing' : 'technical'; }
    } )
    .decision( 'inferred', {
        model,
        questions,
        input    : 'x',
        branches : { billing : 'a', technical : 'b' },
        route    : ( answers ) =>
        {
            const value: 'billing' | 'technical' | 'other' = answers.team.value;

            return value === 'billing' ? 'billing' : 'technical';
        }
    })
    .decision( 'wrong', {
        model,
        questions,
        input    : 'x',
        branches : { billing : 'a', technical : 'b' },
        // @ts-expect-error 'refund' is not a declared branch
        route    : () => { return 'refund'; }
    } );
