const completeMovie = {
  id: 5001,
  mediaType: 'movie',
  title: 'Trakt Complete Movie',
  originalTitle: 'Trakt Complete Movie',
  overview: 'Every household member has finished this one.',
  releaseDate: '2024-01-01',
  posterPath: null,
  backdropPath: null,
  adult: false,
  video: false,
  popularity: 1,
  voteAverage: 5,
  voteCount: 10,
  genreIds: [],
  originalLanguage: 'en',
};

const notStartedMovie = {
  ...completeMovie,
  id: 5002,
  title: 'Trakt Not Started Movie',
  originalTitle: 'Trakt Not Started Movie',
  overview: 'Nobody in the household has started this one.',
};

const partialMovie = {
  ...completeMovie,
  id: 5003,
  title: 'Trakt Partial Movie',
  originalTitle: 'Trakt Partial Movie',
  overview: 'The viewer is partway through this one.',
};

const interceptDiscoverMovies = (
  results: (typeof completeMovie)[],
  alias = 'discoverMovies'
) => {
  cy.intercept('GET', '/api/v1/discover/movies*', {
    page: 1,
    totalPages: 1,
    totalResults: results.length,
    results,
  }).as(alias);
};

describe('Trakt card watch status', () => {
  beforeEach(() => {
    cy.intercept('POST', '/api/v1/trakt/watchstatus/batch', {
      fixture: 'trakt/cardStatus.json',
    }).as('batch');
    interceptDiscoverMovies([completeMovie, notStartedMovie, partialMovie]);
    cy.loginAsAdmin();
  });

  it('renders a chip per household member', () => {
    cy.visit('/discover/movies');
    cy.wait('@discoverMovies');
    cy.wait('@batch');
    cy.get('[data-testid="trakt-watch-chip"]').should('have.length', 8);
  });

  it('shows +N once there are more than four members', () => {
    cy.visit('/discover/movies');
    cy.wait('@discoverMovies');
    cy.wait('@batch');
    cy.get('[data-testid="trakt-watch-chip-overflow"]')
      .should('have.length', 1)
      .and('contain.text', '+1');
  });

  it('dims a card the viewer has completed, and only that one', () => {
    cy.visit('/discover/movies');
    cy.wait('@discoverMovies');
    cy.wait('@batch');
    cy.contains('[data-testid="title-card"]', 'Trakt Complete Movie').within(
      () => {
        cy.get('[data-testid="trakt-watched-dim"]').should('exist');
      }
    );
    cy.contains('[data-testid="title-card"]', 'Trakt Not Started Movie').within(
      () => {
        cy.get('[data-testid="trakt-watched-dim"]').should('not.exist');
      }
    );
    cy.contains('[data-testid="title-card"]', 'Trakt Partial Movie').within(
      () => {
        cy.get('[data-testid="trakt-watched-dim"]').should('not.exist');
      }
    );
  });

  it('chunks a page of more than 100 cards into multiple capped requests', () => {
    const manyMovies = Array.from({ length: 150 }, (_, index) => ({
      ...completeMovie,
      id: 800001 + index,
      title: `Bulk Movie ${index}`,
      originalTitle: `Bulk Movie ${index}`,
    }));

    cy.intercept('GET', '/api/v1/discover/movies*', (req) => {
      const page = Number(new URL(req.url).searchParams.get('page') ?? '1');
      req.reply({
        page,
        totalPages: 1,
        totalResults: manyMovies.length,
        results: page === 1 ? manyMovies : [],
      });
    }).as('discoverManyMovies');

    const seen: number[] = [];
    cy.intercept('POST', '/api/v1/trakt/watchstatus/batch', (req) => {
      seen.push(req.body.items.length);
      req.reply({ fixture: 'trakt/cardStatus.json' });
    }).as('chunked');

    cy.visit('/discover/movies');
    cy.wait('@discoverManyMovies');
    cy.scrollTo('bottom');
    cy.wait('@chunked').then(() => {
      cy.wrap(null).should(() => {
        expect(seen.length).to.be.greaterThan(1);
        expect(Math.max(...seen)).to.be.at.most(100);
      });
    });
  });
});
