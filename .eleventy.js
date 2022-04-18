module.exports = function configureEleventy(eleventyConfig) {
    eleventyConfig.addPassthroughCopy('src/css');
    eleventyConfig.addPassthroughCopy('src/img');

    return {
        dir: {
            input: 'src',
            layouts: '_layouts',
            output: 'dist',
        },
    };
};
