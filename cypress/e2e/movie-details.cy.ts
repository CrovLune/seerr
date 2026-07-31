describe('Movie Details', () => {
  it('shows every watch-status row returned to an administrator', () => {
    cy.loginAsAdmin();
    cy.intercept('GET', '/api/v1/trakt/watchstatus/movie/438148', {
      mediaType: 'movie',
      tmdbId: 438148,
      items: [
        {
          userId: 1,
          displayName: 'admin',
          traktUsername: 'household-admin',
          watched: true,
          watchedAt: '2026-07-30T20:00:00.000Z',
          status: 'ok',
        },
        {
          userId: 2,
          displayName: 'Movie Partner',
          traktUsername: 'movie-partner',
          watched: false,
          watchedAt: null,
          status: 'ok',
        },
      ],
    }).as('movieWatchStatus');

    // Try to load minions: rise of gru
    cy.visit('/movie/438148');
    cy.wait('@movieWatchStatus');

    cy.get('[data-testid=media-title]').should(
      'contain',
      'Minions: The Rise of Gru (2022)'
    );
    cy.get('[data-testid=trakt-watch-status-item]').should('have.length', 2);
    cy.get('[data-testid=trakt-watch-status]').within(() => {
      cy.contains('admin').should('be.visible');
      cy.contains('household-admin').should('be.visible');
      cy.contains('Watched').should('be.visible');
      cy.contains('Jul 30, 2026').should('be.visible');
      cy.contains('Movie Partner').should('be.visible');
      cy.contains('movie-partner').should('be.visible');
      cy.contains('Not watched').should('be.visible');
    });
  });

  it('shows only the ordinary user row returned by the API', () => {
    cy.loginAsUser();
    cy.intercept('GET', '/api/v1/trakt/watchstatus/movie/438148', {
      mediaType: 'movie',
      tmdbId: 438148,
      items: [
        {
          userId: 2,
          displayName: 'Movie User',
          traktUsername: 'movie-user',
          watched: false,
          watchedAt: null,
          status: 'ok',
        },
      ],
    }).as('movieUserWatchStatus');

    cy.visit('/movie/438148');
    cy.wait('@movieUserWatchStatus');

    cy.get('[data-testid=trakt-watch-status-item]').should('have.length', 1);
    cy.get('[data-testid=trakt-watch-status]').within(() => {
      cy.contains('Movie User').should('be.visible');
      cy.contains('movie-user').should('be.visible');
      cy.contains('Not watched').should('be.visible');
      cy.contains('household-admin').should('not.exist');
    });
  });

  it('hides watch status when the API returns no visible connections', () => {
    cy.loginAsUser();
    cy.intercept('GET', '/api/v1/trakt/watchstatus/movie/438148', {
      mediaType: 'movie',
      tmdbId: 438148,
      items: [],
    }).as('emptyMovieWatchStatus');

    cy.visit('/movie/438148');
    cy.wait('@emptyMovieWatchStatus');

    cy.get('[data-testid=trakt-watch-status]').should('not.exist');
  });

  it('does not reopen the manager panel after closing and going back', () => {
    cy.loginAsAdmin();

    cy.visit('/movie/438148');
    cy.visit('/movie/438148?manage=1');

    cy.get('button[aria-label="Close panel"]').should('be.visible').click();
    cy.location('search').should('eq', '');
    cy.get('button[aria-label="Close panel"]').should('not.exist');

    cy.go('back');

    cy.location('search').should('eq', '');
    cy.get('button[aria-label="Close panel"]').should('not.exist');
  });
});
